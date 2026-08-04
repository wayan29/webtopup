use std::{env, time::Duration};

use anyhow::Context;
use opentelemetry::{global, trace::TracerProvider as _, KeyValue};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{propagation::TraceContextPropagator, trace::SdkTracerProvider, Resource};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const DEFAULT_OTLP_TRACES_ENDPOINT: &str = "http://localhost:4318/v1/traces";
const DEFAULT_SERVICE_NAME: &str = "webtopup-rust-api";

pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    pub fn shutdown(self) {
        if let Some(provider) = self.provider {
            if let Err(error) = provider.shutdown() {
                warn!(?error, "failed to shutdown OpenTelemetry tracer provider");
            }
        }
    }
}

pub fn init_tracing() -> anyhow::Result<TelemetryGuard> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "webtopup_rust_api=debug,tower_http=info,axum=info".into());
    let fmt_layer = tracing_subscriber::fmt::layer();

    if !telemetry_enabled() {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return Ok(TelemetryGuard { provider: None });
    }

    let provider = init_tracer_provider()?;
    let tracer = provider.tracer("webtopup-rust-api");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    global::set_text_map_propagator(TraceContextPropagator::new());
    global::set_tracer_provider(provider.clone());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    info!("OpenTelemetry tracing enabled");
    Ok(TelemetryGuard {
        provider: Some(provider),
    })
}

fn telemetry_enabled() -> bool {
    match env::var("OTEL_ENABLED") {
        Ok(value) => matches!(value.trim().to_lowercase().as_str(), "true" | "1" | "on"),
        Err(_) => env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

fn init_tracer_provider() -> anyhow::Result<SdkTracerProvider> {
    let endpoint = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OTLP_TRACES_ENDPOINT.to_string());
    let service_name = env::var("OTEL_SERVICE_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_string());
    let environment = env::var("OTEL_ENVIRONMENT")
        .ok()
        .or_else(|| env::var("RUST_ENV").ok())
        .unwrap_or_else(|| "development".to_string());

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(3))
        .build()
        .context("failed to build OTLP trace exporter")?;

    let resource = Resource::builder()
        .with_service_name(service_name)
        .with_attributes([
            KeyValue::new("service.namespace", "webtopup"),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new("deployment.environment.name", environment),
        ])
        .build();

    Ok(SdkTracerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(exporter)
        .build())
}
