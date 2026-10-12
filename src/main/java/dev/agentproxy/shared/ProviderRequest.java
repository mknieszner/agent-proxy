package dev.agentproxy.shared;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

public record ProviderRequest(
        String method,
        String path,
        String queryString,
        Map<String, List<String>> headers,
        JsonNode body
) {
}
