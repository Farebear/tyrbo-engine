import { TemplateTelemetryEvent } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'

// TYRBO-PATCH: telemetry/phone-home is permanently disabled in this fork.
// Upstream posts template usage events to activepieces.com endpoints; this
// fork keeps the service interface and drops the network calls.
export const templateTelemetryService = (log: FastifyBaseLogger) => ({
    sendEvent(event: TemplateTelemetryEvent): void {
        log.debug({ eventType: event.eventType }, 'Telemetry is disabled, skipping template telemetry event')
    },
})
