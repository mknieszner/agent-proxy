package dev.agentproxy.shared;

import java.time.Instant;

public record ProxyLogEntry(
        String id,
        Instant timestamp,
        String kind,
        Object payload
) {
}
