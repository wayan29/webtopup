use axum::http::{header, HeaderMap};
use mongodb::bson::{doc, oid::ObjectId, DateTime, Document};

use crate::state::AppState;

use super::{decode_access_token, types::AccessClaims};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OptionalMemberAccess {
    pub user_id: ObjectId,
    pub level: String,
}

trait MemberAccessStore: Sync {
    async fn load_user(&self, user_id: ObjectId) -> Result<Option<Document>, ()>;
    async fn load_session(&self, session_id: ObjectId) -> Result<Option<Document>, ()>;
}

struct MongoMemberAccessStore<'a> {
    db: &'a mongodb::Database,
}

impl MemberAccessStore for MongoMemberAccessStore<'_> {
    async fn load_user(&self, user_id: ObjectId) -> Result<Option<Document>, ()> {
        self.db
            .collection::<Document>("users")
            .find_one(doc! { "_id": user_id })
            .projection(doc! {
                "_id": 1,
                "role": 1,
                "level": 1,
                "active": 1,
                "sessionVersion": 1,
            })
            .await
            .map_err(|_| ())
    }

    async fn load_session(&self, session_id: ObjectId) -> Result<Option<Document>, ()> {
        self.db
            .collection::<Document>("authsessions")
            .find_one(doc! { "sessionId": session_id })
            .projection(doc! {
                "sessionId": 1,
                "userId": 1,
                "role": 1,
                "status": 1,
                "sessionVersionAtIssue": 1,
                "absoluteExpiresAt": 1,
            })
            .await
            .map_err(|_| ())
    }
}

pub(crate) async fn resolve_optional_member_access(
    headers: &HeaderMap,
    state: &AppState,
) -> Option<OptionalMemberAccess> {
    let header = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = header.strip_prefix("Bearer ")?;
    let claims = decode_access_token(token, &state.jwt_secret).ok()?;
    if claims.token_type != "access" || claims.role != "member" {
        return None;
    }
    let client = state.mongo_client.as_ref()?;
    let db = client.database(&state.mongo_db);
    resolve_claims_member_access(
        &claims,
        &MongoMemberAccessStore { db: &db },
        DateTime::now(),
    )
    .await
}

async fn resolve_optional_member_access_with_store(
    headers: &HeaderMap,
    jwt_secret: &str,
    store: &impl MemberAccessStore,
    now: DateTime,
) -> Option<OptionalMemberAccess> {
    let header = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = header.strip_prefix("Bearer ")?;
    let claims = decode_access_token(token, jwt_secret).ok()?;
    resolve_claims_member_access(&claims, store, now).await
}

async fn resolve_claims_member_access(
    claims: &AccessClaims,
    store: &impl MemberAccessStore,
    now: DateTime,
) -> Option<OptionalMemberAccess> {
    if claims.token_type != "access" || claims.role != "member" {
        return None;
    }
    let user_id = ObjectId::parse_str(&claims.sub).ok()?;
    let session_id = ObjectId::parse_str(&claims.sid).ok()?;
    let session = store.load_session(session_id).await.ok()??;
    let user = store.load_user(user_id).await.ok()??;
    member_access_bindings_valid_at(claims, &session, &user, now).then(|| {
        let level = match user.get_str("level") {
            Ok("gold") => "gold",
            Ok("platinum") => "platinum",
            _ => "basic",
        };
        OptionalMemberAccess {
            user_id,
            level: level.to_string(),
        }
    })
}

fn member_access_bindings_valid(
    claims: &AccessClaims,
    session: &Document,
    user: &Document,
) -> bool {
    member_access_bindings_valid_at(claims, session, user, DateTime::now())
}

fn strict_integer(document: &Document, key: &str) -> Option<i64> {
    match document.get(key)? {
        mongodb::bson::Bson::Int32(value) => Some(i64::from(*value)),
        mongodb::bson::Bson::Int64(value) => Some(*value),
        _ => None,
    }
}

fn member_access_bindings_valid_at(
    claims: &AccessClaims,
    session: &Document,
    user: &Document,
    now: DateTime,
) -> bool {
    let Ok(claim_user_id) = ObjectId::parse_str(&claims.sub) else {
        return false;
    };
    let Ok(claim_session_id) = ObjectId::parse_str(&claims.sid) else {
        return false;
    };
    let Ok(user_id) = user.get_object_id("_id") else {
        return false;
    };
    let Ok(user_role) = user.get_str("role") else {
        return false;
    };
    let Ok(user_active) = user.get_bool("active") else {
        return false;
    };
    let Some(user_version) = strict_integer(user, "sessionVersion") else {
        return false;
    };
    let Ok(session_id) = session.get_object_id("sessionId") else {
        return false;
    };
    let Ok(session_user_id) = session.get_object_id("userId") else {
        return false;
    };
    let Ok(session_role) = session.get_str("role") else {
        return false;
    };
    let Ok(session_status) = session.get_str("status") else {
        return false;
    };
    let Some(session_version) = strict_integer(session, "sessionVersionAtIssue") else {
        return false;
    };
    let Ok(absolute_expires_at) = session.get_datetime("absoluteExpiresAt") else {
        return false;
    };

    claims.token_type == "access"
        && claims.role == "member"
        && user_role == "member"
        && user_active
        && session_status == "active"
        && session_role == "member"
        && claim_user_id == user_id
        && session_user_id == user_id
        && claim_session_id == session_id
        && claims.role == user_role
        && claims.role == session_role
        && claims.session_version == user_version
        && claims.session_version == session_version
        && *absolute_expires_at > now
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::http::{header, HeaderMap, HeaderValue};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};
    use serde::Serialize;

    use super::{
        member_access_bindings_valid, resolve_claims_member_access,
        resolve_optional_member_access_with_store, AccessClaims, MemberAccessStore,
    };

    const NOW_MILLIS: i64 = 1_000;
    const JWT_SECRET: &str = "test-secret-that-is-long-enough-for-hs256";
    const USER_ID: &str = "64b000000000000000000001";
    const SESSION_ID: &str = "64b000000000000000000002";

    fn claims(token_type: &str, role: &str, version: i64) -> AccessClaims {
        AccessClaims {
            sub: USER_ID.to_string(),
            sid: SESSION_ID.to_string(),
            session_version: version,
            role: role.to_string(),
            iat: super::super::now_seconds() as i64,
            exp: super::super::now_seconds() as i64 + 3_600,
            jti: ObjectId::new().to_hex(),
            token_type: token_type.to_string(),
        }
    }

    fn session(status: &str, version: i64) -> Document {
        doc! {
            "sessionId": ObjectId::parse_str(SESSION_ID).unwrap(),
            "userId": ObjectId::parse_str(USER_ID).unwrap(),
            "role": "member",
            "status": status,
            "sessionVersionAtIssue": version,
            "absoluteExpiresAt": DateTime::from_millis(i64::MAX),
        }
    }

    fn user(role: &str, active: bool, version: i64) -> Document {
        doc! {
            "_id": ObjectId::parse_str(USER_ID).unwrap(),
            "role": role,
            "level": "basic",
            "active": active,
            "sessionVersion": version,
        }
    }

    fn bound_fixture() -> (AccessClaims, Document, Document) {
        (
            claims("access", "member", 7),
            session("active", 7),
            user("member", true, 7),
        )
    }

    #[test]
    fn member_access_requires_current_access_claim_bindings() {
        assert!(member_access_bindings_valid(
            &claims("access", "member", 7),
            &session("active", 7),
            &user("member", true, 7)
        ));
        assert!(!member_access_bindings_valid(
            &claims("refresh", "member", 7),
            &session("active", 7),
            &user("member", true, 7)
        ));
        assert!(!member_access_bindings_valid(
            &claims("access", "admin", 7),
            &session("active", 7),
            &user("admin", true, 7)
        ));
        assert!(!member_access_bindings_valid(
            &claims("access", "member", 6),
            &session("active", 7),
            &user("member", true, 7)
        ));
        assert!(!member_access_bindings_valid(
            &claims("access", "member", 7),
            &session("revoked", 7),
            &user("member", true, 7)
        ));
        assert!(!member_access_bindings_valid(
            &claims("access", "member", 7),
            &session("active", 7),
            &user("member", false, 7)
        ));
    }

    #[test]
    fn member_access_accepts_strict_integer_session_version_bson() {
        let (claims, session, user) = bound_fixture();
        for user_version in [Bson::Int32(7), Bson::Int64(7)] {
            for session_version in [Bson::Int32(7), Bson::Int64(7)] {
                let mut case_user = user.clone();
                case_user.insert("sessionVersion", user_version.clone());
                let mut case_session = session.clone();
                case_session.insert("sessionVersionAtIssue", session_version.clone());
                assert!(
                    member_access_bindings_valid(&claims, &case_session, &case_user),
                    "rejected user={user_version:?}, session={session_version:?}"
                );
            }
        }
    }

    #[test]
    fn member_access_rejects_non_integer_or_missing_session_version_bson() {
        let (claims, session, user) = bound_fixture();
        for malformed in [
            Some(Bson::String("7".to_string())),
            Some(Bson::Boolean(true)),
            Some(Bson::Double(7.0)),
            None,
        ] {
            let mut case_user = user.clone();
            match malformed.clone() {
                Some(value) => {
                    case_user.insert("sessionVersion", value);
                }
                None => {
                    case_user.remove("sessionVersion");
                }
            }
            assert!(!member_access_bindings_valid(&claims, &session, &case_user));

            let mut case_session = session.clone();
            match malformed {
                Some(value) => {
                    case_session.insert("sessionVersionAtIssue", value);
                }
                None => {
                    case_session.remove("sessionVersionAtIssue");
                }
            }
            assert!(!member_access_bindings_valid(&claims, &case_session, &user));
        }
    }

    #[test]
    fn member_access_binds_every_claim_session_and_user_field() {
        let (claims, session, user) = bound_fixture();
        let mut cases = Vec::new();

        let mut wrong_user_id = user.clone();
        wrong_user_id.insert("_id", ObjectId::new());
        cases.push((claims.clone(), session.clone(), wrong_user_id));

        let mut wrong_session_id = session.clone();
        wrong_session_id.insert("sessionId", ObjectId::new());
        cases.push((claims.clone(), wrong_session_id, user.clone()));

        let mut wrong_owner = session.clone();
        wrong_owner.insert("userId", ObjectId::new());
        cases.push((claims.clone(), wrong_owner, user.clone()));

        let mut wrong_role = session.clone();
        wrong_role.insert("role", "admin");
        cases.push((claims.clone(), wrong_role, user.clone()));

        let mut wrong_version = session.clone();
        wrong_version.insert("sessionVersionAtIssue", 8_i64);
        cases.push((claims.clone(), wrong_version, user.clone()));

        let mut expired = session.clone();
        expired.insert("absoluteExpiresAt", DateTime::from_millis(NOW_MILLIS));
        cases.push((claims.clone(), expired, user.clone()));

        for (claims, session, user) in cases {
            assert!(!super::member_access_bindings_valid_at(
                &claims,
                &session,
                &user,
                DateTime::from_millis(NOW_MILLIS)
            ));
        }
    }

    struct FixtureStore {
        user: Option<Document>,
        session: Option<Document>,
        fail: bool,
        loaded: Mutex<Vec<&'static str>>,
    }

    impl MemberAccessStore for FixtureStore {
        async fn load_user(&self, _user_id: ObjectId) -> Result<Option<Document>, ()> {
            self.loaded.lock().unwrap().push("user");
            if self.fail {
                Err(())
            } else {
                Ok(self.user.clone())
            }
        }

        async fn load_session(&self, _session_id: ObjectId) -> Result<Option<Document>, ()> {
            self.loaded.lock().unwrap().push("session");
            if self.fail {
                Err(())
            } else {
                Ok(self.session.clone())
            }
        }
    }

    async fn resolve_fixture(
        claims: &AccessClaims,
        session: Document,
        user: Document,
    ) -> Option<super::OptionalMemberAccess> {
        resolve_claims_member_access(
            claims,
            &FixtureStore {
                user: Some(user),
                session: Some(session),
                fail: false,
                loaded: Mutex::new(Vec::new()),
            },
            DateTime::from_millis(NOW_MILLIS),
        )
        .await
    }

    #[tokio::test]
    async fn authoritative_store_seam_accepts_int32_and_int64_session_versions() {
        let (claims, session, user) = bound_fixture();
        for user_version in [Bson::Int32(7), Bson::Int64(7)] {
            for session_version in [Bson::Int32(7), Bson::Int64(7)] {
                let mut case_user = user.clone();
                case_user.insert("sessionVersion", user_version.clone());
                let mut case_session = session.clone();
                case_session.insert("sessionVersionAtIssue", session_version.clone());
                assert!(
                    resolve_fixture(&claims, case_session, case_user)
                        .await
                        .is_some(),
                    "store seam rejected user={user_version:?}, session={session_version:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn authoritative_store_seam_returns_current_normalized_level() {
        for (stored, expected) in [
            (Bson::String("basic".into()), "basic"),
            (Bson::String("gold".into()), "gold"),
            (Bson::String("platinum".into()), "platinum"),
            (Bson::String("owner".into()), "basic"),
            (Bson::Null, "basic"),
        ] {
            let (claims, session, mut user) = bound_fixture();
            user.insert("level", stored);
            let access = resolve_fixture(&claims, session, user).await.unwrap();
            assert_eq!(access.user_id.to_hex(), claims.sub);
            assert_eq!(access.level, expected);
        }
    }

    fn bearer_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        headers
    }

    fn signed_access(claims: &AccessClaims) -> String {
        super::super::sign_access_token(claims, JWT_SECRET).unwrap()
    }

    async fn resolve_headers(
        headers: &HeaderMap,
        session: Document,
        user: Document,
    ) -> Option<super::OptionalMemberAccess> {
        resolve_optional_member_access_with_store(
            headers,
            JWT_SECRET,
            &FixtureStore {
                user: Some(user),
                session: Some(session),
                fail: false,
                loaded: Mutex::new(Vec::new()),
            },
            DateTime::from_millis(NOW_MILLIS),
        )
        .await
    }

    #[tokio::test]
    async fn optional_bearer_requires_exact_current_access_envelope() {
        let (claims, session, user) = bound_fixture();
        let token = signed_access(&claims);
        assert!(
            resolve_headers(&bearer_headers(&token), session.clone(), user.clone())
                .await
                .is_some()
        );

        assert!(
            resolve_headers(&HeaderMap::new(), session.clone(), user.clone())
                .await
                .is_none()
        );
        let mut wrong_prefix = HeaderMap::new();
        wrong_prefix.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("bearer {token}")).unwrap(),
        );
        assert!(
            resolve_headers(&wrong_prefix, session.clone(), user.clone())
                .await
                .is_none()
        );
        assert!(
            resolve_headers(&bearer_headers("not-a-jwt"), session.clone(), user.clone())
                .await
                .is_none()
        );

        #[derive(Serialize)]
        struct LegacyClaims<'a> {
            id: &'a str,
            role: &'a str,
            exp: i64,
        }
        let legacy = encode(
            &Header::default(),
            &LegacyClaims {
                id: &claims.sub,
                role: "member",
                exp: super::super::now_seconds() as i64 + 3_600,
            },
            &EncodingKey::from_secret(JWT_SECRET.as_bytes()),
        )
        .unwrap();
        assert!(resolve_headers(&bearer_headers(&legacy), session, user)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn invalid_optional_bearers_never_grant_member_authority() {
        let (claims, session, user) = bound_fixture();
        let cases = [
            ("refresh", "member", "active", true, 7_i64),
            ("access", "admin", "active", true, 7_i64),
            ("access", "member", "active", false, 7_i64),
            ("access", "member", "revoked", true, 7_i64),
            ("access", "member", "locked", true, 7_i64),
            ("access", "member", "expired", true, 7_i64),
            ("access", "member", "active", true, 8_i64),
        ];
        for (token_type, role, status, active, version) in cases {
            let mut case_claims = claims.clone();
            case_claims.token_type = token_type.to_string();
            case_claims.role = role.to_string();
            let mut case_session = session.clone();
            case_session.insert("status", status);
            let mut case_user = user.clone();
            case_user.insert("active", active);
            case_user.insert("sessionVersion", version);
            let token = signed_access(&case_claims);
            assert!(
                resolve_headers(&bearer_headers(&token), case_session, case_user)
                    .await
                    .is_none(),
                "{token_type}/{role}/{status}/active={active}/version={version} granted member authority"
            );
        }

        let mut wrong_owner = session;
        wrong_owner.insert("userId", ObjectId::new());
        let token = signed_access(&claims);
        assert!(resolve_headers(&bearer_headers(&token), wrong_owner, user)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn authoritative_store_seam_fails_closed_on_invalid_authority_and_bson() {
        let (claims, session, user) = bound_fixture();
        let mut invalid_rows = Vec::new();
        for key in ["_id", "role", "active", "sessionVersion"] {
            let mut malformed = user.clone();
            malformed.insert(key, "wrong BSON type");
            invalid_rows.push((session.clone(), malformed));
        }
        for key in [
            "sessionId",
            "userId",
            "role",
            "status",
            "sessionVersionAtIssue",
            "absoluteExpiresAt",
        ] {
            let mut malformed = session.clone();
            malformed.insert(key, true);
            invalid_rows.push((malformed, user.clone()));
        }
        for (session, user) in invalid_rows {
            assert!(resolve_fixture(&claims, session, user).await.is_none());
        }

        for status in ["revoked", "locked", "expired"] {
            let mut invalid = session.clone();
            invalid.insert("status", status);
            assert!(resolve_fixture(&claims, invalid, user.clone())
                .await
                .is_none());
        }
    }
}
