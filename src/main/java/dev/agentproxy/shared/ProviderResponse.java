package dev.agentproxy.shared;

import java.util.List;
import java.util.Map;

public record ProviderResponse(
        int statusCode,
        Map<String, List<String>> headers,
        String body
) {
}
