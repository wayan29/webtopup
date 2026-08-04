use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
pub struct AuthErrorBody {
    pub error: AuthErrorDetail,
}

#[derive(Serialize)]
pub struct AuthErrorDetail {
    pub code: &'static str,
    pub message: &'static str,
}

pub fn auth_error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(AuthErrorBody {
            error: AuthErrorDetail { code, message },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{auth_error, AuthErrorBody, AuthErrorDetail};

    #[test]
    fn auth_error_response_has_stable_shape() {
        let value = serde_json::to_value(AuthErrorBody {
            error: AuthErrorDetail {
                code: "AUTH_ACCESS_EXPIRED",
                message: "Access token telah kedaluwarsa",
            },
        })
        .expect("serialize auth error");

        assert_eq!(
            value,
            json!({
                "error": {
                    "code": "AUTH_ACCESS_EXPIRED",
                    "message": "Access token telah kedaluwarsa"
                }
            })
        );

        let response = auth_error(
            axum::http::StatusCode::UNAUTHORIZED,
            "AUTH_ACCESS_EXPIRED",
            "Access token telah kedaluwarsa",
        );
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }
}
