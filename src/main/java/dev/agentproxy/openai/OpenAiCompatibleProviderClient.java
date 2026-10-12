package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.agentproxy.shared.AgentProxyProperties;
import dev.agentproxy.shared.ModelProviderClient;
import dev.agentproxy.shared.ProviderRequest;
import dev.agentproxy.shared.ProviderResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class OpenAiCompatibleProviderClient implements ModelProviderClient {

    private static final Set<String> SENSITIVE_HEADERS = Set.of(
            "authorization",
            "cookie",
            "proxy-authorization",
            "set-cookie",
            "x-api-key",
            "api-key"
    );
    private static final Set<String> HOP_BY_HOP_HEADERS = Set.of(
            "accept-encoding",
            "connection",
            "content-encoding",
            "content-length",
            "expect",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade"
    );
    private static final Set<String> UPSTREAM_PASSTHROUGH_HEADERS = Set.of(
            "openai-beta",
            "openai-organization",
            "openai-project"
    );

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final AgentProxyProperties properties;

    public OpenAiCompatibleProviderClient(ObjectMapper objectMapper, AgentProxyProperties properties) {
        this.httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(30))
                .build();
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    @Override
    public String upstreamUri(String path, String queryString) {
        var base = properties.getEffectiveOpenAiCompatibleBaseUrl();
        if (!StringUtils.hasText(base)) {
            throw new IllegalStateException("Missing agent-proxy.openai-compatible.base-url.");
        }
        var uri = base.replaceAll("/+$", "") + path;
        if (StringUtils.hasText(queryString)) {
            uri += "?" + queryString;
        }
        return uri;
    }

    @Override
    public ProviderResponse send(ProviderRequest request) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(upstreamUri(request.path(), request.queryString())))
                .timeout(Duration.ofMinutes(10));
        copyForwardHeaders(request, builder);
        builder.header(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey());
        builder.header(HttpHeaders.ACCEPT, "application/json");

        if ("POST".equalsIgnoreCase(request.method())) {
            var bodyText = request.body() != null ? objectMapper.writeValueAsString(request.body()) : "{}";
            builder.header(HttpHeaders.CONTENT_TYPE, "application/json");
            builder.POST(HttpRequest.BodyPublishers.ofString(bodyText, StandardCharsets.UTF_8));
        } else {
            builder.GET();
        }

        var response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        return new ProviderResponse(response.statusCode(), response.headers().map(), response.body());
    }

    private String apiKey() {
        var apiKey = properties.getEffectiveOpenAiCompatibleApiKey();
        if (!StringUtils.hasText(apiKey)) {
            throw new IllegalStateException("Missing agent-proxy.openai-compatible.api-key.");
        }
        return apiKey.trim();
    }

    private void copyForwardHeaders(ProviderRequest request, HttpRequest.Builder builder) {
        request.headers().forEach((name, values) -> {
            var normalized = name.toLowerCase(Locale.ROOT);
            if (!UPSTREAM_PASSTHROUGH_HEADERS.contains(normalized)) {
                return;
            }
            if (HOP_BY_HOP_HEADERS.contains(normalized) || SENSITIVE_HEADERS.contains(normalized)) {
                return;
            }
            for (String value : values != null ? values : List.<String>of()) {
                builder.header(name, value);
            }
        });
    }
}
