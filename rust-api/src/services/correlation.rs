use axum::http::HeaderMap;

pub const GATEWAY_CORRELATION_HEADER: &str = "x-webtopup-correlation-id";

const ALL_ZERO_TRACE_ID: &str = "00000000000000000000000000000000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CorrelationSource {
    OtelSpan,
    GatewayHeader,
    Absent,
}

impl CorrelationSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OtelSpan => "otel_span",
            Self::GatewayHeader => "gateway_header",
            Self::Absent => "absent",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorrelationResolution {
    pub trace_id: Option<String>,
    pub source: CorrelationSource,
}

pub fn validate_trace_id(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() == 32
        && trimmed != ALL_ZERO_TRACE_ID
        && trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Span-only resolution; never admits a gateway header candidate.
pub fn resolve_correlation_untrusted(
    _headers: &HeaderMap,
    active_span_trace_id: Option<&str>,
) -> CorrelationResolution {
    if let Some(span_id) = active_span_trace_id {
        if validate_trace_id(span_id) {
            return CorrelationResolution {
                trace_id: Some(span_id.to_ascii_lowercase()),
                source: CorrelationSource::OtelSpan,
            };
        }
    }

    CorrelationResolution {
        trace_id: None,
        source: CorrelationSource::Absent,
    }
}

pub fn current_span_correlation_trace_id() -> Option<String> {
    span_correlation_trace_id_from(&tracing::Span::current())
}

pub fn span_correlation_trace_id_from(span: &tracing::Span) -> Option<String> {
    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;

    let otel_context = span.context();
    let otel_span = otel_context.span();
    let span_context = otel_span.span_context();
    if !span_context.is_valid() {
        return None;
    }
    let trace_id = span_context.trace_id().to_string();
    if validate_trace_id(&trace_id) {
        Some(trace_id)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_TRACE: &str = "4bf92f3577b34da6a3ce929d0e0e4736";

    fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
        use axum::http::header::HeaderName;
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            let header_name: HeaderName = name.parse().expect("header name");
            headers.insert(header_name, (*value).parse().expect("header value"));
        }
        headers
    }

    #[test]
    fn correlation_module_has_no_public_trusted_admission_api() {
        let src = include_str!("correlation.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !production.contains("trusted_gateway_header_candidate"),
            "public gateway header reader must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("trusted_gateway_candidate: Option"),
            "gateway-candidate resolver parameter must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("fn trusted_gateway_header_candidate"),
            "gateway header reader function must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("pub fn resolve_correlation("),
            "public gateway-capable resolve_correlation must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("pub trait TrustedGateway"),
            "forbidden trust trait must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("pub trait Sealed"),
            "sealed trait must not exist in production correlation.rs"
        );
        assert!(
            !production.contains("pub(crate) mod private"),
            "forgeable private sealing module must not exist in production correlation.rs"
        );
    }

    #[test]
    fn span_only_resolver_uses_active_span_trace_id() {
        let headers = header_map(&[(
            GATEWAY_CORRELATION_HEADER,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )]);
        let resolved = resolve_correlation_untrusted(&headers, Some(VALID_TRACE));
        assert_eq!(
            resolved,
            CorrelationResolution {
                trace_id: Some(VALID_TRACE.to_string()),
                source: CorrelationSource::OtelSpan,
            }
        );
    }

    #[test]
    fn gateway_header_ignored_in_untrusted_resolver() {
        let headers = header_map(&[(GATEWAY_CORRELATION_HEADER, VALID_TRACE)]);
        let resolved = resolve_correlation_untrusted(&headers, None);
        assert_eq!(resolved.source, CorrelationSource::Absent);
        assert!(resolved.trace_id.is_none());
    }

    #[test]
    fn correlation_source_strings_match_contract() {
        assert_eq!(CorrelationSource::OtelSpan.as_str(), "otel_span");
        assert_eq!(CorrelationSource::GatewayHeader.as_str(), "gateway_header");
        assert_eq!(CorrelationSource::Absent.as_str(), "absent");
    }

    #[test]
    fn validate_trace_id_rejects_invalid_values() {
        assert!(validate_trace_id(VALID_TRACE));
        assert!(!validate_trace_id("4BF92F3577B34DA6A3CE929D0E0E4736"));
        assert!(!validate_trace_id("abcd"));
        assert!(!validate_trace_id("00000000000000000000000000000000"));
    }
}
