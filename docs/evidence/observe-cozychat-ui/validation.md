# Observe UI validation

The implementation follows the user’s current CozyChat graphite/rust direction, recorded in `packages/gateway/PRODUCT.md`, and issue #429.

- Node 24 `pnpm check`: build, typecheck, and 2,354 tests passed; 26 existing skips.
- Auth/asset coverage verifies the fixed public PNG route, exact source bytes, MIME, CSP, versioned caching, feature disablement, and continued protection of dashboard JavaScript and session access.
- Actual pairing UI inspected in the in-app browser at 390×844 in light and dark modes and 1280×720 in dark mode. Mobile uses a compact craft-detail header and no scene below the form. Wide desktop leaves all four characters clear of the opaque form.
- Tall/square windows use the compact layout to avoid cropping characters at the scene edges.
- All original dashboard IDs and panel hooks retained; independent spec and standards/security review performed.
- Static text contrast checks passed for primary actions, selections, secondary text, placeholders, and errors in both themes.

The preview uses disposable local fixtures with the real Gateway auth flow. No production observer credential, model invocation, or runtime image-generation service is involved. This record establishes local validation, not deployment.
