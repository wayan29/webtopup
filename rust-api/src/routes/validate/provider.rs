use std::{env, time::Duration};

use axum::http::StatusCode;
use chrono::{Datelike, Local};
use serde_json::Value;

use super::types::{NicknameResult, NicknameResultKind};

pub(super) const PUBLIC_PROVIDER_OUTAGE_MESSAGE: &str =
    "Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.";

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
const CODASHOP_DEFAULT_BASE_URL: &str = "https://order-sg.codashop.com";
const GOPAY_DEFAULT_BASE_URL: &str = "https://gopay.co.id";
/// Exact development validation sandbox loopback base URL (no trailing slash).
const SANDBOX_LOOPBACK_BASE_URL: &str = "http://127.0.0.1:9020";
/// Explicit sandbox-only invalid body marker emitted by the local provider stub.
const SANDBOX_INVALID_MARKER: &str = "webtopup-sandbox-invalid";
/// Explicit sandbox-only invalid response header name/value contract.
const SANDBOX_INVALID_HEADER_NAME: &str = "x-webtopup-sandbox";
const SANDBOX_INVALID_HEADER_VALUE: &str = "invalid";

fn provider_base_url(env_key: &str, default_base_url: &str) -> String {
    env::var(env_key)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_base_url.to_string())
}

fn codashop_base_url() -> String {
    provider_base_url(
        "GAME_VALIDATION_CODASHOP_BASE_URL",
        CODASHOP_DEFAULT_BASE_URL,
    )
}

fn gopay_base_url() -> String {
    provider_base_url("GAME_VALIDATION_GOPAY_BASE_URL", GOPAY_DEFAULT_BASE_URL)
}

/// Pure gate: only the exact development loopback sandbox base URL may use sandbox-only contracts.
pub(super) fn is_exact_loopback_sandbox_base_url(base_url: &str) -> bool {
    base_url.trim().trim_end_matches('/') == SANDBOX_LOOPBACK_BASE_URL
}

/// Pure gate: response carries the explicit sandbox-only invalid marker/header/body contract.
pub(super) fn has_explicit_sandbox_invalid_marker(
    body: Option<&Value>,
    header_value: Option<&str>,
) -> bool {
    let header_ok = header_value
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case(SANDBOX_INVALID_HEADER_VALUE));
    let body_ok = body
        .and_then(|value| value.get("sandboxMarker"))
        .and_then(Value::as_str)
        .is_some_and(|marker| marker == SANDBOX_INVALID_MARKER);
    header_ok && body_ok
}

/// Classify an explicit invalid sandbox fixture as terminal `NotFound` only when both:
/// 1) adapter base URL is the exact loopback sandbox URL, and
/// 2) the response carries the explicit sandbox-only marker/header/body contract.
/// Production/default providers remain conservative `ProviderError` for the same body.
pub(super) fn classify_sandbox_gated_invalid(
    base_url: &str,
    body: Option<&Value>,
    header_value: Option<&str>,
) -> NicknameResult {
    if is_exact_loopback_sandbox_base_url(base_url)
        && has_explicit_sandbox_invalid_marker(body, header_value)
    {
        return NicknameResult {
            is_success: false,
            kind: NicknameResultKind::NotFound,
            nickname: None,
            message: Some("User ID tidak valid".to_string()),
        };
    }
    provider_transport_error("non-sandbox or unmarked invalid".to_string())
}

pub async fn inquire_freefire_nickname(user_id: &str) -> NicknameResult {
    let date = Local::now().date_naive();
    let nonce = format!(
        "{:04}/{:02}/{:02}-{}",
        date.year(),
        date.month(),
        date.day(),
        rand::random::<u16>() % 1000
    );
    let payload = serde_json::json!({
        "voucherPricePoint.id": 8120,
        "voucherPricePoint.price": 50000.0,
        "voucherPricePoint.variablePrice": 0,
        "n": nonce,
        "email": "",
        "userVariablePrice": 0,
        "order.data.profile": "eyJuYW1lIjoiICIsImRhdGVvZmJpcnRoIjoiIiwiaWRfbm8iOiIifQ==",
        "user.userId": user_id,
        "user.zoneId": "",
        "msisdn": "",
        "voucherTypeName": "FREEFIRE",
        "shopLang": "id_ID",
        "voucherTypeId": 17,
        "gvtId": 33,
        "checkoutId": "",
        "affiliateTrackingId": "",
        "impactClickId": "",
        "anonymousId": ""
    });
    let base_url = codashop_base_url();
    let result = fetch_provider_http(
        reqwest::Client::new()
            .post(format!("{}/initPayment.action", base_url))
            .header("Content-Type", "application/json")
            .header("Origin", "https://www.codashop.com")
            .header("Referer", "https://www.codashop.com/")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36")
            .json(&payload),
        "Codashop Free Fire",
    )
    .await;
    let Ok(http) = result else {
        return inquire_ff_via_gopay(user_id).await;
    };
    if let Some(outcome) =
        classify_codashop_http_outage_before_body(http.status, http.body.as_ref())
    {
        let fallback = inquire_ff_via_gopay(user_id).await;
        return merge_codashop_with_fallback(outcome, fallback);
    }
    if !http.status.is_success() {
        return inquire_ff_via_gopay(user_id).await;
    }
    let Some(response_data) = http.body else {
        let fallback = inquire_ff_via_gopay(user_id).await;
        return merge_codashop_with_fallback(
            provider_transport_error("parse".to_string()),
            fallback,
        );
    };
    if is_too_many_attempts(&response_data) {
        return NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some(PUBLIC_PROVIDER_OUTAGE_MESSAGE.to_string()),
        };
    }
    if response_data
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && response_data.get("errorMsg").is_none()
    {
        if let Some(nickname) = extract_codashop_nickname(&response_data) {
            return NicknameResult {
                is_success: true,
                kind: NicknameResultKind::Success,
                nickname: Some(nickname),
                message: Some("Nickname inquiry successful.".to_string()),
            };
        }
        return inquire_ff_via_gopay(user_id).await;
    }
    if response_data
        .get("errorMsg")
        .and_then(Value::as_str)
        .is_some()
    {
        let primary = classify_codashop_invalid_response(
            &base_url,
            Some(&response_data),
            http.sandbox_header.as_deref(),
        );
        let fallback = inquire_ff_via_gopay(user_id).await;
        return merge_codashop_with_fallback(primary, fallback);
    }
    inquire_ff_via_gopay(user_id).await
}

pub async fn inquire_mobilelegends_nickname(user_id: &str, zone_id: &str) -> NicknameResult {
    let date = Local::now().date_naive();
    let nonce = format!(
        "{:04}/{:02}/{:02}-{}",
        date.year(),
        date.month(),
        date.day(),
        rand::random::<u16>() % 1000
    );
    let payload = serde_json::json!({
        "voucherPricePoint.id": 1471,
        "voucherPricePoint.price": 84360.0,
        "voucherPricePoint.variablePrice": 0,
        "n": nonce,
        "email": "",
        "userVariablePrice": 0,
        "order.data.profile": "eyJuYW1lIjoiICIsImRhdGVvZmJpcnRoIjoiIiwiaWRfbm8iOiIifQ==",
        "user.userId": user_id,
        "user.zoneId": zone_id,
        "msisdn": "",
        "voucherTypeName": "MOBILE_LEGENDS",
        "shopLang": "id_ID",
        "voucherTypeId": 5,
        "gvtId": 19,
        "checkoutId": "",
        "affiliateTrackingId": "",
        "impactClickId": "",
        "anonymousId": ""
    });
    let base_url = codashop_base_url();
    let result = fetch_provider_http(
        reqwest::Client::new()
            .post(format!("{}/initPayment.action", base_url))
            .header("Content-Type", "application/json")
            .header("Origin", "https://www.codashop.com")
            .header("Referer", "https://www.codashop.com/")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36")
            .json(&payload),
        "Codashop Mobile Legends",
    )
    .await;
    let Ok(http) = result else {
        return inquire_ml_via_gopay(user_id, zone_id).await;
    };
    if let Some(outcome) =
        classify_codashop_http_outage_before_body(http.status, http.body.as_ref())
    {
        let fallback = inquire_ml_via_gopay(user_id, zone_id).await;
        return merge_codashop_with_fallback(outcome, fallback);
    }
    if !http.status.is_success() {
        return inquire_ml_via_gopay(user_id, zone_id).await;
    }
    let Some(response_data) = http.body else {
        let fallback = inquire_ml_via_gopay(user_id, zone_id).await;
        return merge_codashop_with_fallback(
            provider_transport_error("parse".to_string()),
            fallback,
        );
    };
    if is_too_many_attempts(&response_data) {
        return NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some(PUBLIC_PROVIDER_OUTAGE_MESSAGE.to_string()),
        };
    }
    if response_data
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && response_data.get("errorMsg").is_none()
    {
        if let Some(nickname) = extract_codashop_nickname(&response_data) {
            return NicknameResult {
                is_success: true,
                kind: NicknameResultKind::Success,
                nickname: Some(nickname),
                message: Some("Nickname inquiry successful.".to_string()),
            };
        }
        return inquire_ml_via_gopay(user_id, zone_id).await;
    }
    if response_data
        .get("errorMsg")
        .and_then(Value::as_str)
        .is_some()
    {
        let primary = classify_codashop_invalid_response(
            &base_url,
            Some(&response_data),
            http.sandbox_header.as_deref(),
        );
        let fallback = inquire_ml_via_gopay(user_id, zone_id).await;
        return merge_codashop_with_fallback(primary, fallback);
    }
    inquire_ml_via_gopay(user_id, zone_id).await
}

/// Codashop `errorMsg` is not a verified invalid-account-only field in this repository.
/// Until stable documented markers exist, treat every `errorMsg` conservatively as outage/ambiguous
/// unless the sandbox gate classifies an explicit sandbox-only invalid fixture.
pub(super) fn classify_codashop_error_msg(_message: &str) -> NicknameResult {
    provider_transport_error("codashop errorMsg".to_string())
}

/// Sandbox-gated Codashop invalid classification. Default/live URLs stay ProviderError.
pub(super) fn classify_codashop_invalid_response(
    base_url: &str,
    body: Option<&Value>,
    header_value: Option<&str>,
) -> NicknameResult {
    classify_sandbox_gated_invalid(base_url, body, header_value)
}

/// HTTP status is classified before JSON semantics. Returns `Some(ProviderError)` for outage/auth/throttle/5xx
/// and for successful HTTP status with an unparsable/missing JSON body.
pub(super) fn classify_codashop_http_outage_before_body(
    status: StatusCode,
    body: Option<&Value>,
) -> Option<NicknameResult> {
    if classify_provider_http(status, false) == NicknameResultKind::ProviderError {
        return Some(provider_transport_error(format!("HTTP {status}")));
    }
    if status.is_success() && body.is_none() {
        return Some(provider_transport_error("parse".to_string()));
    }
    None
}

/// Keeps success or `ProviderError` from either side over weaker `NotFound`.
pub(super) fn merge_codashop_with_fallback(
    primary: NicknameResult,
    fallback: NicknameResult,
) -> NicknameResult {
    if fallback.is_success {
        return fallback;
    }
    if fallback.kind == NicknameResultKind::ProviderError {
        return NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some(provider_error_public_message(&fallback)),
        };
    }
    if primary.kind == NicknameResultKind::ProviderError {
        return NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some(provider_error_public_message(&primary)),
        };
    }
    primary
}

async fn inquire_ff_via_gopay(user_id: &str) -> NicknameResult {
    let base_url = gopay_base_url();
    let url = format!(
        "{}/games/v1/order/prepare/FREEFIRE?userId={}&zoneId=",
        base_url, user_id
    );
    let result = fetch_provider_http(
        reqwest::Client::new()
            .get(url)
            .header("Accept", "application/json")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"),
        "GoPay Free Fire",
    )
    .await;
    match result {
        Ok(http) => classify_gopay_ff_http_response_gated(
            &base_url,
            http.status,
            http.body.as_ref(),
            http.sandbox_header.as_deref(),
        ),
        Err(_) => provider_transport_error("transport".to_string()),
    }
}

async fn inquire_ml_via_gopay(user_id: &str, zone_id: &str) -> NicknameResult {
    let base_url = gopay_base_url();
    let payload = serde_json::json!({
        "code": "MOBILE_LEGENDS",
        "data": { "userId": user_id, "zoneId": zone_id }
    });
    let result = fetch_provider_http(
        reqwest::Client::new()
            .post(format!("{}/games/v1/order/user-account", base_url))
            .header("Content-Type", "application/json")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")
            .json(&payload),
        "GoPay Mobile Legends",
    )
    .await;
    match result {
        Ok(http) => classify_gopay_ml_http_response_gated(
            &base_url,
            http.status,
            http.body.as_ref(),
            http.sandbox_header.as_deref(),
        ),
        Err(_) => provider_transport_error("transport".to_string()),
    }
}

fn provider_transport_error(_detail: String) -> NicknameResult {
    NicknameResult {
        is_success: false,
        kind: NicknameResultKind::ProviderError,
        nickname: None,
        message: Some(PUBLIC_PROVIDER_OUTAGE_MESSAGE.to_string()),
    }
}

fn provider_error_public_message(fallback: &NicknameResult) -> String {
    fallback
        .message
        .as_deref()
        .filter(|message| !message.is_empty())
        .unwrap_or(PUBLIC_PROVIDER_OUTAGE_MESSAGE)
        .to_string()
}

pub(super) fn classify_provider_http(
    status: StatusCode,
    explicit_not_found: bool,
) -> NicknameResultKind {
    let code = status.as_u16();
    if code == 429 || code >= 500 {
        return NicknameResultKind::ProviderError;
    }
    if code == 401 || code == 403 {
        return NicknameResultKind::ProviderError;
    }
    if !status.is_success() {
        if explicit_not_found {
            return NicknameResultKind::NotFound;
        }
        return NicknameResultKind::ProviderError;
    }
    if explicit_not_found {
        return NicknameResultKind::NotFound;
    }
    NicknameResultKind::Success
}

pub(super) struct ProviderHttpResponse {
    pub status: StatusCode,
    pub body: Option<Value>,
    pub sandbox_header: Option<String>,
}

pub(super) fn classify_gopay_ff_http_response(
    status: StatusCode,
    body: Option<&Value>,
) -> NicknameResult {
    classify_gopay_ff_http_response_gated(CODASHOP_DEFAULT_BASE_URL, status, body, None)
}

pub(super) fn classify_gopay_ml_http_response(
    status: StatusCode,
    body: Option<&Value>,
) -> NicknameResult {
    classify_gopay_ml_http_response_gated(CODASHOP_DEFAULT_BASE_URL, status, body, None)
}

pub(super) fn classify_gopay_ff_http_response_gated(
    base_url: &str,
    status: StatusCode,
    body: Option<&Value>,
    sandbox_header: Option<&str>,
) -> NicknameResult {
    if classify_provider_http(status, false) == NicknameResultKind::ProviderError {
        return provider_transport_error(format!("HTTP {status}"));
    }
    let Some(body) = body else {
        return provider_transport_error("parse".to_string());
    };
    classify_gopay_ff_response_gated(base_url, status, body, sandbox_header)
}

pub(super) fn classify_gopay_ml_http_response_gated(
    base_url: &str,
    status: StatusCode,
    body: Option<&Value>,
    sandbox_header: Option<&str>,
) -> NicknameResult {
    if classify_provider_http(status, false) == NicknameResultKind::ProviderError {
        return provider_transport_error(format!("HTTP {status}"));
    }
    let Some(body) = body else {
        return provider_transport_error("parse".to_string());
    };
    classify_gopay_ml_response_gated(base_url, status, body, sandbox_header)
}

/// GoPay has no verified explicit invalid-account marker in live fixtures; non-success bodies stay
/// `ProviderError` unless the sandbox gate classifies an explicit sandbox-only invalid fixture.
pub(super) fn classify_gopay_ff_response(status: StatusCode, body: &Value) -> NicknameResult {
    classify_gopay_ff_response_gated(CODASHOP_DEFAULT_BASE_URL, status, body, None)
}

pub(super) fn classify_gopay_ml_response(status: StatusCode, body: &Value) -> NicknameResult {
    classify_gopay_ml_response_gated(CODASHOP_DEFAULT_BASE_URL, status, body, None)
}

pub(super) fn classify_gopay_ff_response_gated(
    base_url: &str,
    status: StatusCode,
    body: &Value,
    sandbox_header: Option<&str>,
) -> NicknameResult {
    if status.is_success()
        && body
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.eq_ignore_ascii_case("success"))
        && body.get("data").and_then(Value::as_str).is_some()
    {
        return NicknameResult {
            is_success: true,
            kind: NicknameResultKind::Success,
            nickname: body
                .get("data")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            message: Some("Nickname found.".to_string()),
        };
    }
    if has_explicit_sandbox_invalid_marker(Some(body), sandbox_header) {
        return classify_sandbox_gated_invalid(base_url, Some(body), sandbox_header);
    }
    provider_transport_error("ambiguous body".to_string())
}

pub(super) fn classify_gopay_ml_response_gated(
    base_url: &str,
    status: StatusCode,
    body: &Value,
    sandbox_header: Option<&str>,
) -> NicknameResult {
    if status.is_success()
        && body
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.eq_ignore_ascii_case("success"))
        && body
            .pointer("/data/username")
            .and_then(Value::as_str)
            .is_some()
    {
        return NicknameResult {
            is_success: true,
            kind: NicknameResultKind::Success,
            nickname: body
                .pointer("/data/username")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            message: Some("Nickname found.".to_string()),
        };
    }
    if has_explicit_sandbox_invalid_marker(Some(body), sandbox_header) {
        return classify_sandbox_gated_invalid(base_url, Some(body), sandbox_header);
    }
    provider_transport_error("ambiguous body".to_string())
}

pub(super) fn parse_provider_json_body(raw_body: &str) -> Option<Value> {
    if raw_body.trim().is_empty() {
        return None;
    }
    serde_json::from_str(raw_body).ok()
}

async fn fetch_provider_http(
    request: reqwest::RequestBuilder,
    provider_name: &str,
) -> Result<ProviderHttpResponse, String> {
    let response = tokio::time::timeout(PROVIDER_TIMEOUT, request.send())
        .await
        .map_err(|_| format!("{provider_name} timeout"))?
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let sandbox_header = response
        .headers()
        .get(SANDBOX_INVALID_HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let raw_body = response.text().await.map_err(|error| error.to_string())?;
    let body = parse_provider_json_body(&raw_body);
    Ok(ProviderHttpResponse {
        status,
        body,
        sandbox_header,
    })
}

fn is_too_many_attempts(value: &Value) -> bool {
    value
        .get("RESULT_CODE")
        .or_else(|| value.get("resultCode"))
        .and_then(Value::as_str)
        == Some("10001")
}

fn extract_codashop_nickname(value: &Value) -> Option<String> {
    value
        .pointer("/confirmationFields/roles/0/role")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/confirmationFields/username")
                .and_then(Value::as_str)
        })
        .map(decode_uri_component)
        .or_else(|| {
            let result = value.get("result")?.as_str()?;
            let decoded = decode_uri_component(result);
            let parsed = serde_json::from_str::<Value>(&decoded).ok()?;
            parsed
                .pointer("/roles/0/role")
                .and_then(Value::as_str)
                .or_else(|| parsed.get("username").and_then(Value::as_str))
                .map(decode_uri_component)
        })
}

fn decode_uri_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    output.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        if bytes[index] == b'+' {
            output.push(b' ');
        } else {
            output.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_http_429_is_provider_error() {
        assert_eq!(
            classify_provider_http(StatusCode::TOO_MANY_REQUESTS, false),
            NicknameResultKind::ProviderError
        );
    }

    #[test]
    fn classify_http_503_is_provider_error() {
        assert_eq!(
            classify_provider_http(StatusCode::SERVICE_UNAVAILABLE, false),
            NicknameResultKind::ProviderError
        );
    }

    #[test]
    fn classify_http_401_is_provider_error() {
        assert_eq!(
            classify_provider_http(StatusCode::UNAUTHORIZED, false),
            NicknameResultKind::ProviderError
        );
    }

    #[test]
    fn classify_http_403_is_provider_error() {
        assert_eq!(
            classify_provider_http(StatusCode::FORBIDDEN, false),
            NicknameResultKind::ProviderError
        );
    }

    #[test]
    fn classify_non_success_without_marker_is_provider_error() {
        assert_eq!(
            classify_provider_http(StatusCode::BAD_REQUEST, false),
            NicknameResultKind::ProviderError
        );
    }

    #[test]
    fn classify_explicit_not_found_on_400_is_not_found() {
        assert_eq!(
            classify_provider_http(StatusCode::BAD_REQUEST, true),
            NicknameResultKind::NotFound
        );
    }

    #[test]
    fn classify_2xx_without_marker_is_success() {
        assert_eq!(
            classify_provider_http(StatusCode::OK, false),
            NicknameResultKind::Success
        );
    }

    #[test]
    fn gopay_ambiguous_200_body_is_provider_error() {
        let body = serde_json::json!({ "message": "Invalid User ID or unknown error." });
        let result = classify_gopay_ff_response(StatusCode::OK, &body);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
        assert_eq!(
            result.message.as_deref(),
            Some(PUBLIC_PROVIDER_OUTAGE_MESSAGE)
        );
    }

    #[test]
    fn gopay_non_json_401_is_provider_error() {
        let result = classify_gopay_ff_http_response(StatusCode::UNAUTHORIZED, None);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn gopay_non_json_429_is_provider_error() {
        let result = classify_gopay_ff_http_response(StatusCode::TOO_MANY_REQUESTS, None);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn gopay_non_json_500_is_provider_error() {
        let result = classify_gopay_ff_http_response(StatusCode::INTERNAL_SERVER_ERROR, None);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn gopay_200_parse_failure_is_provider_error() {
        let result = classify_gopay_ff_http_response(StatusCode::OK, None);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn gopay_does_not_support_explicit_not_found() {
        let body = serde_json::json!({ "message": "Invalid User ID or unknown error." });
        let result = classify_gopay_ff_http_response(StatusCode::OK, Some(&body));
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
        assert_ne!(result.kind, NicknameResultKind::NotFound);
    }

    #[test]
    fn codashop_http_401_before_body_is_provider_error() {
        let outage = classify_codashop_http_outage_before_body(StatusCode::UNAUTHORIZED, None);
        assert_eq!(
            outage.as_ref().map(|value| &value.kind),
            Some(&NicknameResultKind::ProviderError)
        );
    }

    #[test]
    fn codashop_http_200_unparseable_body_is_provider_error() {
        let outage = classify_codashop_http_outage_before_body(StatusCode::OK, None);
        assert_eq!(
            outage.as_ref().map(|value| &value.kind),
            Some(&NicknameResultKind::ProviderError)
        );
    }

    #[test]
    fn codashop_error_msg_is_conservative_provider_error() {
        for message in [
            "User ID tidak valid",
            "Authentication failed",
            "Too many requests",
            "Maintenance in progress",
            "Unknown error",
        ] {
            let result = classify_codashop_error_msg(message);
            assert_eq!(
                result.kind,
                NicknameResultKind::ProviderError,
                "message: {message}"
            );
        }
    }

    #[test]
    fn merge_keeps_primary_provider_error_over_fallback_not_found() {
        let primary = provider_transport_error("HTTP 401".to_string());
        let fallback = NicknameResult {
            is_success: false,
            kind: NicknameResultKind::NotFound,
            nickname: None,
            message: Some("Invalid User ID".to_string()),
        };
        let merged = merge_codashop_with_fallback(primary, fallback);
        assert_eq!(merged.kind, NicknameResultKind::ProviderError);
        assert_eq!(
            merged.message.as_deref(),
            Some(PUBLIC_PROVIDER_OUTAGE_MESSAGE)
        );
    }

    #[test]
    fn merge_keeps_fallback_provider_error_over_codashop_provider_error() {
        let primary = classify_codashop_error_msg("User ID tidak valid");
        let fallback = provider_transport_error("timeout".to_string());
        let merged = merge_codashop_with_fallback(primary, fallback);
        assert_eq!(merged.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn parse_provider_json_body_rejects_non_json() {
        assert!(parse_provider_json_body("<html>401</html>").is_none());
        assert!(parse_provider_json_body("").is_none());
        assert!(parse_provider_json_body("{\"ok\":true}").is_some());
    }

    fn sandbox_invalid_body() -> Value {
        serde_json::json!({
            "success": false,
            "errorMsg": "Sandbox invalid user id (synthetic)",
            "sandboxMarker": SANDBOX_INVALID_MARKER,
        })
    }

    #[test]
    fn loopback_sandbox_invalid_with_marker_is_not_found() {
        let body = sandbox_invalid_body();
        let result = classify_sandbox_gated_invalid(
            SANDBOX_LOOPBACK_BASE_URL,
            Some(&body),
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(result.kind, NicknameResultKind::NotFound);
        assert!(!result.is_success);
    }

    #[test]
    fn default_live_url_same_invalid_body_is_provider_error() {
        let body = sandbox_invalid_body();
        let result = classify_sandbox_gated_invalid(
            CODASHOP_DEFAULT_BASE_URL,
            Some(&body),
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
        assert_ne!(result.kind, NicknameResultKind::NotFound);
    }

    #[test]
    fn sandbox_outage_body_without_invalid_marker_is_provider_error() {
        let body = serde_json::json!({
            "success": false,
            "errorMsg": "Sandbox synthetic provider outage",
        });
        let result = classify_sandbox_gated_invalid(SANDBOX_LOOPBACK_BASE_URL, Some(&body), None);
        assert_eq!(result.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn sandbox_success_body_unchanged() {
        let body = serde_json::json!({
            "message": "success",
            "data": "Sandbox FF syn-ff-ok",
        });
        let result = classify_gopay_ff_response_gated(
            SANDBOX_LOOPBACK_BASE_URL,
            StatusCode::OK,
            &body,
            None,
        );
        assert_eq!(result.kind, NicknameResultKind::Success);
        assert_eq!(result.nickname.as_deref(), Some("Sandbox FF syn-ff-ok"));
    }

    #[test]
    fn codashop_invalid_response_gate_uses_loopback_only() {
        let body = sandbox_invalid_body();
        let sandbox = classify_codashop_invalid_response(
            SANDBOX_LOOPBACK_BASE_URL,
            Some(&body),
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(sandbox.kind, NicknameResultKind::NotFound);

        let live = classify_codashop_invalid_response(
            CODASHOP_DEFAULT_BASE_URL,
            Some(&body),
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(live.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn gopay_sandbox_invalid_marker_is_not_found_only_on_loopback() {
        let body = serde_json::json!({
            "message": "Invalid User ID or unknown error.",
            "sandboxMarker": SANDBOX_INVALID_MARKER,
        });
        let sandbox = classify_gopay_ff_response_gated(
            SANDBOX_LOOPBACK_BASE_URL,
            StatusCode::OK,
            &body,
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(sandbox.kind, NicknameResultKind::NotFound);

        let live = classify_gopay_ff_response_gated(
            GOPAY_DEFAULT_BASE_URL,
            StatusCode::OK,
            &body,
            Some(SANDBOX_INVALID_HEADER_VALUE),
        );
        assert_eq!(live.kind, NicknameResultKind::ProviderError);
    }

    #[test]
    fn exact_loopback_sandbox_base_url_gate() {
        assert!(is_exact_loopback_sandbox_base_url("http://127.0.0.1:9020"));
        assert!(is_exact_loopback_sandbox_base_url("http://127.0.0.1:9020/"));
        assert!(!is_exact_loopback_sandbox_base_url("http://0.0.0.0:9020"));
        assert!(!is_exact_loopback_sandbox_base_url("http://127.0.0.1:9021"));
        assert!(!is_exact_loopback_sandbox_base_url(
            CODASHOP_DEFAULT_BASE_URL
        ));
    }
}
