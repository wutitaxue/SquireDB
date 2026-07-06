use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, Row};

/// A MySQL account (user@host) plus its grants, as shown in the Users GUI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbUser {
    pub user: String,
    pub host: String,
    /// True when the account is locked (account_locked = 'Y'). None on server
    /// versions without the column.
    pub locked: Option<bool>,
    /// Raw `SHOW GRANTS` lines for this account. Empty if the grant read
    /// failed (e.g. insufficient privileges) — see `grants_error`.
    pub grants: Vec<String>,
    pub grants_error: Option<String>,
}

/// List all accounts from `mysql.user` with their grants. Requires the SELECT
/// privilege on the `mysql` database (or global). Falls back gracefully when
/// `account_locked` doesn't exist (MySQL < 5.7).
pub async fn list_users(pool: &MySqlPool) -> Result<Vec<DbUser>, String> {
    // Probe the account_locked column once — older servers lack it.
    let has_locked: bool = sqlx::query(
        "SELECT COUNT(*) AS c FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user' \
         AND COLUMN_NAME = 'account_locked'",
    )
    .fetch_one(pool)
    .await
    .map(|r| r.try_get::<i64, _>("c").unwrap_or(0) > 0)
    .unwrap_or(false);

    let sql = if has_locked {
        "SELECT CAST(User AS CHAR) u, CAST(Host AS CHAR) h, \
            CAST(account_locked AS CHAR) locked \
         FROM mysql.user ORDER BY User, Host"
    } else {
        "SELECT CAST(User AS CHAR) u, CAST(Host AS CHAR) h, \
            CAST('' AS CHAR) locked \
         FROM mysql.user ORDER BY User, Host"
    };

    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list users failed: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let user: String = row.try_get("u").unwrap_or_default();
        let host: String = row.try_get("h").unwrap_or_default();
        let locked = if has_locked {
            let l: String = row.try_get("locked").unwrap_or_default();
            Some(l.eq_ignore_ascii_case("Y"))
        } else {
            None
        };
        let (grants, grants_error) = match show_grants(pool, &user, &host).await {
            Ok(g) => (g, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        out.push(DbUser {
            user,
            host,
            locked,
            grants,
            grants_error,
        });
    }
    Ok(out)
}

async fn show_grants(pool: &MySqlPool, user: &str, host: &str) -> Result<Vec<String>, String> {
    let stmt = format!(
        "SHOW GRANTS FOR {}@{}",
        quote_string(user),
        quote_string(host)
    );
    let rows = sqlx::query(&stmt)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("{stmt}: {e}"))?;
    let mut lines = Vec::with_capacity(rows.len());
    for row in &rows {
        // SHOW GRANTS returns a single column whose name varies; read by index.
        if let Ok(s) = row.try_get::<String, _>(0) {
            lines.push(s);
        }
    }
    Ok(lines)
}

/// A structured user-management request. Composed into SQL server-side so the
/// identifier and value quoting is centralized (no string-building in the UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UserAction {
    /// CREATE USER 'u'@'h' IDENTIFIED BY 'pw'
    CreateUser {
        user: String,
        host: String,
        password: String,
    },
    /// ALTER USER 'u'@'h' IDENTIFIED BY 'pw'  (change password)
    SetPassword {
        user: String,
        host: String,
        password: String,
    },
    /// DROP USER 'u'@'h'
    DropUser { user: String, host: String },
    /// ALTER USER 'u'@'h' ACCOUNT LOCK | UNLOCK
    SetLock {
        user: String,
        host: String,
        locked: bool,
    },
    /// GRANT <privs> ON <scope> TO 'u'@'h'  (scope like `db`.* or `db`.`tbl`)
    Grant {
        user: String,
        host: String,
        privileges: String,
        scope: String,
    },
    /// REVOKE <privs> ON <scope> FROM 'u'@'h'
    Revoke {
        user: String,
        host: String,
        privileges: String,
        scope: String,
    },
}

/// Render a UserAction to the exact SQL that will run. Shown to the user for
/// confirmation before execution — the frontend previews this, then calls
/// `apply_user_action` which composes the identical SQL and runs it.
pub fn action_sql(action: &UserAction) -> Result<String, String> {
    let sql = match action {
        UserAction::CreateUser {
            user,
            host,
            password,
        } => format!(
            "CREATE USER {}@{} IDENTIFIED BY {}",
            quote_string(user),
            quote_string(host),
            quote_string(password)
        ),
        UserAction::SetPassword {
            user,
            host,
            password,
        } => format!(
            "ALTER USER {}@{} IDENTIFIED BY {}",
            quote_string(user),
            quote_string(host),
            quote_string(password)
        ),
        UserAction::DropUser { user, host } => {
            format!("DROP USER {}@{}", quote_string(user), quote_string(host))
        }
        UserAction::SetLock { user, host, locked } => format!(
            "ALTER USER {}@{} ACCOUNT {}",
            quote_string(user),
            quote_string(host),
            if *locked { "LOCK" } else { "UNLOCK" }
        ),
        UserAction::Grant {
            user,
            host,
            privileges,
            scope,
        } => {
            let privs = validate_privileges(privileges)?;
            format!(
                "GRANT {} ON {} TO {}@{}",
                privs,
                scope,
                quote_string(user),
                quote_string(host)
            )
        }
        UserAction::Revoke {
            user,
            host,
            privileges,
            scope,
        } => {
            let privs = validate_privileges(privileges)?;
            format!(
                "REVOKE {} ON {} FROM {}@{}",
                privs,
                scope,
                quote_string(user),
                quote_string(host)
            )
        }
    };
    Ok(sql)
}

/// Compose and execute a user action. Returns the SQL that ran so the UI can
/// echo exactly what was applied.
pub async fn apply_user_action(pool: &MySqlPool, action: &UserAction) -> Result<String, String> {
    let sql = action_sql(action)?;
    sqlx::query(sql.as_str())
        .execute(pool)
        .await
        .map_err(|e| format!("{sql}: {e}"))?;
    Ok(sql)
}

/// Single-quote a string literal / identifier value for GRANT-family syntax,
/// escaping embedded quotes and backslashes.
fn quote_string(s: &str) -> String {
    let esc = s.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{esc}'")
}

/// Privilege lists can't be safely single-quoted (they're SQL keywords), so we
/// validate the shape instead: comma-separated words / ALL PRIVILEGES / GRANT
/// OPTION, letters+spaces only. Column-level privs (with parenthesized column
/// lists) are rejected here — kept simple for the first cut.
fn validate_privileges(privs: &str) -> Result<String, String> {
    let p = privs.trim();
    if p.is_empty() {
        return Err("no privileges specified".to_string());
    }
    for part in p.split(',') {
        let word = part.trim();
        if word.is_empty() {
            return Err("empty privilege in list".to_string());
        }
        if !word.chars().all(|c| c.is_ascii_alphabetic() || c == ' ') {
            return Err(format!("invalid privilege token: {word}"));
        }
    }
    Ok(p.to_uppercase())
}
