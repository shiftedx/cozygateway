"""Private local files: POSIX modes and native Windows DACLs, without following links."""
from __future__ import annotations

import ctypes
import json
import os
import re
import stat
import sys
import tempfile
from functools import lru_cache
from pathlib import Path


def _is_darwin_system_alias(candidate: Path, info, leaf: Path) -> bool:
    # macOS exposes these OS-owned aliases in normal temporary/config paths.
    # Only exact root aliases are trusted, never a selected leaf or a user link.
    if (sys.platform != "darwin" or candidate == leaf or candidate.parent != Path("/")
            or candidate.name not in {"var", "tmp", "etc"} or getattr(info, "st_uid", None) != 0):
        return False
    try:
        return candidate.resolve(strict=True) == Path("/private") / candidate.name
    except OSError:
        return False


def reject_links(path: Path) -> None:
    leaf = path.absolute()
    for candidate in (leaf, *leaf.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            if _is_darwin_system_alias(candidate, info, leaf):
                continue
            raise OSError("private path must not follow a link or reparse point")


@lru_cache(maxsize=1)
def _windows_api():
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    signatures = {
        "CreateFileW": ([w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
        "ReOpenFile": ([w.HANDLE, w.DWORD, w.DWORD, w.DWORD], w.HANDLE),
        "CloseHandle": ([w.HANDLE], w.BOOL),
        "GetCurrentProcess": ([], w.HANDLE),
        "GetFileInformationByHandleEx": ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD], w.BOOL),
        "LocalFree": ([w.LPVOID], w.LPVOID),
    }
    for name, (args, result) in signatures.items():
        function = getattr(kernel, name); function.argtypes = args; function.restype = result
    signatures = {
        "OpenProcessToken": ([w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)], w.BOOL),
        "GetTokenInformation": ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)], w.BOOL),
        "ConvertSidToStringSidW": ([w.LPVOID, ctypes.POINTER(w.LPWSTR)], w.BOOL),
        "ConvertStringSecurityDescriptorToSecurityDescriptorW": ([w.LPCWSTR, w.DWORD, ctypes.POINTER(w.LPVOID), w.LPVOID], w.BOOL),
        "SetKernelObjectSecurity": ([w.HANDLE, w.DWORD, w.LPVOID], w.BOOL),
        "GetKernelObjectSecurity": ([w.HANDLE, w.DWORD, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)], w.BOOL),
        "ConvertSecurityDescriptorToStringSecurityDescriptorW": ([w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(w.LPWSTR), w.LPVOID], w.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(security, name); function.argtypes = args; function.restype = result
    return kernel, security


@lru_cache(maxsize=1)
def _current_sid() -> str:
    from ctypes import wintypes as w
    kernel, security = _windows_api()
    token = w.HANDLE()
    if not security.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = w.DWORD()
        security.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not security.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        text = w.LPWSTR()
        if not security.ConvertSidToStringSidW(ctypes.cast(buffer, ctypes.POINTER(w.LPVOID))[0], ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, w.LPVOID))
    finally:
        kernel.CloseHandle(token)


def _with_windows_handle(path: Path, access: int, action):
    kernel, _ = _windows_api()
    handle = kernel.CreateFileW(str(path), access, 7, None, 3, 0x02200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = (ctypes.c_ulong * 2)()
        if not kernel.GetFileInformationByHandleEx(handle, 9, attributes, ctypes.sizeof(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())
        if attributes[0] & 0x400:
            raise OSError("private path must not be a reparse point")
        return action(handle)
    finally:
        kernel.CloseHandle(handle)


def secure_path(path: Path, *, directory: bool = False, fd: int | None = None) -> None:
    reject_links(path)
    if os.name != "nt":
        if fd is None:
            path.chmod(0o700 if directory else 0o600)
        else:
            os.fchmod(fd, 0o600)
        return
    from ctypes import wintypes as w
    kernel, security = _windows_api()
    inheritance = "OICI" if directory else ""
    sddl = "D:P" + "".join(f"(A;{inheritance};FA;;;{sid})" for sid in (_current_sid(), "SY", "BA"))
    descriptor = w.LPVOID()
    if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        def apply(handle):
            if not security.SetKernelObjectSecurity(handle, 0x80000004, descriptor):
                raise ctypes.WinError(ctypes.get_last_error())
        if fd is None:
            _with_windows_handle(path, 0x00040000, apply)
        else:
            import msvcrt
            handle = kernel.ReOpenFile(msvcrt.get_osfhandle(fd), 0x00060000, 7, 0)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                apply(handle)
            finally:
                kernel.CloseHandle(handle)
    finally:
        kernel.LocalFree(descriptor)


def assert_private_fd(fd: int) -> None:
    if os.name != "nt":
        if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
            raise OSError("private file must not be group- or world-readable")
        return
    import msvcrt
    from ctypes import wintypes as w
    kernel, security = _windows_api()
    size = w.DWORD()
    handle = msvcrt.get_osfhandle(fd)
    security.GetKernelObjectSecurity(handle, 4, None, 0, ctypes.byref(size))
    buffer = ctypes.create_string_buffer(size.value)
    if not security.GetKernelObjectSecurity(handle, 4, buffer, size, ctypes.byref(size)):
        raise ctypes.WinError(ctypes.get_last_error())
    text = w.LPWSTR()
    if not security.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer, 1, 4, ctypes.byref(text), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        dacl = text.value
        aces = re.findall(r"\(([^()]*)\)", dacl)
        trusted = {_current_sid(), "SY", "BA"}
        if not aces or any(len(fields := ace.split(";")) != 6 or fields[0] != "A" or fields[5] not in trusted for ace in aces):
            raise OSError("private file must not grant access to other users")
    finally:
        kernel.LocalFree(ctypes.cast(text, w.LPVOID))


def secure_directory(path: Path) -> None:
    reject_links(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    secure_path(path, directory=True)


def write_private_json(path: Path, value) -> None:
    write_private_text(path, json.dumps(value, separators=(",", ":")))


def write_private_text(path: Path, content: str) -> None:
    reject_links(path)
    secure_directory(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=".private-", dir=path.parent)
    unowned_fd = fd
    try:
        # Give fdopen ownership before ACL setup, so an ACL failure closes the
        # descriptor before cleanup (Windows cannot unlink an open CRT file).
        handle = os.fdopen(fd, "w", encoding="utf-8")
        unowned_fd = None
        with handle:
            secure_path(Path(temporary), fd=handle.fileno())
            assert_private_fd(handle.fileno())
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        reject_links(path)
        os.replace(temporary, path)
    finally:
        if unowned_fd is not None:
            os.close(unowned_fd)
        if os.path.exists(temporary):
            os.unlink(temporary)
