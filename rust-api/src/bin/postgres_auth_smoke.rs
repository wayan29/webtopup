use std::{env, process::ExitCode};

use webtopup_rust_api::postgres_auth::{AuthError, AuthStore, LoginAudience};
#[tokio::main]
async fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let action = args.next().unwrap_or_default();
    let database_url = match env::var("DATABASE_URL") {
        Ok(value) if value.contains("/webtopup_pg_dev") => value,
        _ => return ExitCode::from(2),
    };
    let Ok(store) = AuthStore::connect(&database_url).await else {
        return ExitCode::from(3);
    };
    let result = match action.as_str() {
        "profile" => {
            let Some(email) = args.next() else { return ExitCode::from(2); };
            match store.profile_by_email(&email).await {
                Ok(Some(profile)) => {
                    println!("{} {} {} {}", profile.role, profile.active, profile.balance, profile.points);
                    return ExitCode::SUCCESS;
                }
                Ok(None) => return ExitCode::from(10),
                Err(error) => Err(error),
            }
        }
        "login" => {
            let (Some(audience), Some(email), Some(password)) = (args.next(), args.next(), args.next()) else {
                return ExitCode::from(2);
            };
            let audience = match audience.as_str() {
                "member" => LoginAudience::Member,
                "staff" => LoginAudience::Staff,
                _ => return ExitCode::from(2),
            };
            store.login(audience, &email, &password).await.map(|session| {
                println!("{} {} {}", session.user_id, session.session_id, String::from_utf8_lossy(&session.refresh_digest));
            })
        }
        "revoke" => {
            let Some(Ok(user_id)) = args.next().map(|value| value.parse()) else { return ExitCode::from(2); };
            store.revoke_all(user_id).await
        }
        "rotate" => {
            let (Some(Ok(session_id)), Some(predecessor)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            store.rotate(session_id, predecessor.as_bytes()).await.map(|generation| println!("{generation}"))
        }
        "role" => {
            let (Some(Ok(user_id)), Some(role)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            store.change_role(user_id, &role).await.map(|generation| println!("{generation}"))
        }
        "authorize" => {
            let (Some(Ok(session_id)), Some(permission)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            store.authorize(session_id, &permission).await.map(|allowed| println!("{allowed}"))
        }
        "race" => {
            let (Some(Ok(session_id)), Some(predecessor)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            let digest = predecessor.as_bytes().to_vec();
            let first = store.rotate(session_id, &digest);
            let second = store.rotate(session_id, &digest);
            let (left, right) = tokio::join!(first, second);
            println!("{:?} {:?}", left.ok(), right.ok());
            return ExitCode::SUCCESS;
        }
        "enroll" => {
            let (Some(Ok(user_id)), Some(secret)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            store.enroll_two_factor(user_id, secret.as_bytes()).await
        }
        "confirm" => {
            let (Some(Ok(user_id)), Some(code)) = (args.next().map(|value| value.parse()), args.next()) else { return ExitCode::from(2); };
            store.confirm_two_factor(user_id, &code).await
        }
        _ => return ExitCode::from(2),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(AuthError::InvalidCredentials) => ExitCode::from(10),
        Err(AuthError::Conflict) => ExitCode::from(11),
        Err(AuthError::Unavailable) => ExitCode::from(3),
    }
}
