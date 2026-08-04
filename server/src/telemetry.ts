import dotenv from 'dotenv';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_NAMESPACE,
    ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

dotenv.config();

const DEFAULT_OTLP_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces';
const DEFAULT_SERVICE_NAME = 'webtopup-node-gateway';

const isTelemetryEnabled = () => {
    const value = process.env.OTEL_ENABLED?.trim().toLowerCase();
    if (value === undefined) {
        return Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());
    }
    return value === 'true' || value === '1' || value === 'on';
};

const resolveDiagLogLevel = () => {
    switch (process.env.OTEL_LOG_LEVEL?.trim().toLowerCase()) {
        case 'debug':
            return DiagLogLevel.DEBUG;
        case 'info':
            return DiagLogLevel.INFO;
        case 'warn':
            return DiagLogLevel.WARN;
        case 'error':
            return DiagLogLevel.ERROR;
        case 'none':
            return DiagLogLevel.NONE;
        default:
            return undefined;
    }
};

const diagLogLevel = resolveDiagLogLevel();
if (diagLogLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), diagLogLevel);
}

let sdk: NodeSDK | undefined;
let isShuttingDown = false;

if (isTelemetryEnabled()) {
    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
    const endpoint =
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || DEFAULT_OTLP_TRACES_ENDPOINT;
    const environment =
        process.env.OTEL_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || 'development';

    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
            [ATTR_SERVICE_NAMESPACE]: 'webtopup',
            [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'unknown',
            [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
        }),
        traceExporter: new OTLPTraceExporter({
            url: endpoint,
        }),
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': {
                    enabled: false,
                },
            }),
        ],
    });

    sdk.start();
}

export const shutdownTelemetry = async () => {
    if (!sdk || isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    await sdk.shutdown();
};

const shutdownAndExit = (signal: NodeJS.Signals) => {
    shutdownTelemetry()
        .catch((error) => {
            console.error('Failed to shutdown OpenTelemetry', error);
        })
        .finally(() => {
            process.kill(process.pid, signal);
        });
};

if (sdk) {
    process.once('SIGTERM', shutdownAndExit);
    process.once('SIGINT', shutdownAndExit);
}
