import { DatabaseSync } from "node:sqlite";

import { credentialHash, newCredential, newHouseholdId } from "./ids.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS households (
  household_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS hostname_pool (
  hostname TEXT PRIMARY KEY,
  assigned_household TEXT
) STRICT;
`;

export interface ProvisionedHousehold { householdId: string; credential: string; hostname: string; }

export interface FrontdoorStorage {
  syncPool(hostnames: string[]): void;
  provisionHousehold(nowMs: number): ProvisionedHousehold | undefined;
  rotateCredential(householdId: string): string | undefined;
  deprovisionHousehold(householdId: string): boolean;
  householdIdForCredential(credential: string): string | undefined;
  householdIdForHostname(hostname: string): string | undefined;
  householdCount(): number;
  hostnamePoolCount(): number;
  freeHostnameCount(): number;
  close(): void;
}

export function openFrontdoorStorage(dbPath: string): FrontdoorStorage {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return {
    syncPool(hostnames) {
      const ins = db.prepare("INSERT OR IGNORE INTO hostname_pool (hostname, assigned_household) VALUES (?, NULL)");
      for (const h of hostnames) ins.run(h.toLowerCase());
    },
    provisionHousehold(nowMs) {
      for (;;) {
        db.exec("BEGIN IMMEDIATE");
        let transactionOpen = true;
        try {
          const free = db.prepare(
            "SELECT hostname FROM hostname_pool WHERE assigned_household IS NULL ORDER BY hostname LIMIT 1",
          ).get() as { hostname: string } | undefined;
          if (free === undefined) {
            db.exec("COMMIT");
            transactionOpen = false;
            return undefined;
          }
          const householdId = newHouseholdId();
          const credential = newCredential();
          const update = db.prepare(
            "UPDATE hostname_pool SET assigned_household = ? WHERE hostname = ? AND assigned_household IS NULL",
          ).run(householdId, free.hostname);
          if (update.changes !== 1) {
            db.exec("ROLLBACK");
            transactionOpen = false;
            continue;
          }
          db.prepare(
            "INSERT INTO households (household_id, credential_hash, hostname, created_at) VALUES (?, ?, ?, ?)",
          ).run(householdId, credentialHash(credential), free.hostname, nowMs);
          db.exec("COMMIT");
          transactionOpen = false;
          return { householdId, credential, hostname: free.hostname };
        } catch (error) {
          if (transactionOpen) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original transaction error.
            }
          }
          throw error;
        }
      }
    },
    rotateCredential(householdId) {
      const credential = newCredential();
      db.exec("BEGIN IMMEDIATE");
      let transactionOpen = true;
      try {
        const result = db.prepare(
          "UPDATE households SET credential_hash = ? WHERE household_id = ?",
        ).run(credentialHash(credential), householdId);
        if (result.changes !== 1) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return undefined;
        }
        db.exec("COMMIT");
        transactionOpen = false;
        return credential;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original transaction error.
          }
        }
        throw error;
      }
    },
    deprovisionHousehold(householdId) {
      db.exec("BEGIN IMMEDIATE");
      let transactionOpen = true;
      try {
        const household = db.prepare(
          "SELECT household_id FROM households WHERE household_id = ?",
        ).get(householdId) as { household_id: string } | undefined;
        if (household === undefined) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return false;
        }
        db.prepare("UPDATE hostname_pool SET assigned_household = NULL WHERE assigned_household = ?")
          .run(householdId);
        db.prepare("DELETE FROM households WHERE household_id = ?").run(householdId);
        db.exec("COMMIT");
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original transaction error.
          }
        }
        throw error;
      }
    },
    householdIdForCredential(credential) {
      const row = db.prepare("SELECT household_id FROM households WHERE credential_hash = ?")
        .get(credentialHash(credential)) as { household_id: string } | undefined;
      return row?.household_id;
    },
    householdIdForHostname(hostname) {
      const row = db.prepare("SELECT household_id FROM households WHERE hostname = ?")
        .get(hostname.toLowerCase()) as { household_id: string } | undefined;
      return row?.household_id;
    },
    householdCount() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number };
      return row.n;
    },
    hostnamePoolCount() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM hostname_pool").get() as { n: number };
      return row.n;
    },
    freeHostnameCount() {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM hostname_pool WHERE assigned_household IS NULL",
      ).get() as { n: number };
      return row.n;
    },
    close() { db.close(); },
  };
}
