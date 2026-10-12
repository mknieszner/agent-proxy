package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.agentproxy.shared.ModelProviderClient;
import dev.agentproxy.shared.ProviderRequest;
import dev.agentproxy.shared.ProxyExchangeLogger;
import dev.agentproxy.shared.ProxyLogEntry;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

@Service
public class OpenAiProxyService {

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
    private static final Set<String> LOGGED_PATHS = Set.of("/v1/responses");
    private static final Pattern VALID_HTTP_HEADER_NAME = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");

    private final ObjectMapper objectMapper;
    private final ModelProviderClient modelProviderClient;
    private final ProxyExchangeLogger exchangeLogger;

    public OpenAiProxyService(
            ObjectMapper objectMapper,
            ModelProviderClient modelProviderClient,
            ProxyExchangeLogger exchangeLogger
    ) {
        this.objectMapper = objectMapper;
        this.modelProviderClient = modelProviderClient;
        this.exchangeLogger = exchangeLogger;
    }

    public ResponseEntity<String> proxyGet(String upstreamPath, HttpServletRequest servletRequest) {
        return proxy(upstreamPath, servletRequest, null);
    }

    public ResponseEntity<String> proxyPost(String upstreamPath, HttpServletRequest servletRequest, JsonNode body) {
        return proxy(upstreamPath, servletRequest, body);
    }

    private ResponseEntity<String> proxy(String upstreamPath, HttpServletRequest servletRequest, JsonNode body) {
        var exchangeId = UUID.randomUUID().toString();
        var startedAt = Instant.now();
        var upstreamUri = modelProviderClient.upstreamUri(upstreamPath, servletRequest.getQueryString());
        var method = servletRequest.getMethod();
        var shouldLogExchange = shouldLogExchange(upstreamPath);

        if (shouldLogExchange) {
            exchangeLogger.append(new ProxyLogEntry(
                    exchangeId,
                    startedAt,
                    "proxy-request",
                    Map.of(
                            "method", method,
                            "path", upstreamPath,
                            "upstreamUri", upstreamUri.toString(),
                            "headers", sanitizedHeaders(servletRequest),
                            "body", body != null ? body : Map.of(),
                            "toolsPresent", body != null && body.has("tools"),
                            "toolsCount", body != null && body.has("tools") && body.get("tools").isArray()
                                    ? body.get("tools").size()
                                    : 0,
                            "toolPolicy", "forwarded to the configured model provider as provided; proxy does not execute tools"
                    )
            ));
        }

        try {
            var providerRequest = new ProviderRequest(
                    method,
                    upstreamPath,
                    servletRequest.getQueryString(),
                    requestHeaders(servletRequest),
                    body
            );
            var upstreamResponse = modelProviderClient.send(providerRequest);
            var responseBody = upstreamResponse.body();
            if (shouldLogExchange) {
                var responsePayload = new LinkedHashMap<String, Object>();
                responsePayload.put("status", upstreamResponse.statusCode());
                responsePayload.put("headers", sanitizedHeaders(upstreamResponse.headers()));
                responsePayload.put("body", parseJsonOrText(responseBody));
                responsePayload.put("durationMs", Duration.between(startedAt, Instant.now()).toMillis());
                responsePayload.put("complete", true);
                exchangeLogger.append(new ProxyLogEntry(
                        exchangeId, Instant.now(), "proxy-response", responsePayload
                ));
            }
            return responseEntity(upstreamResponse.statusCode(), upstreamResponse.headers(), responseBody);
        } catch (Exception exception) {
            if (shouldLogExchange) {
                exchangeLogger.append(new ProxyLogEntry(
                        exchangeId,
                        Instant.now(),
                        "proxy-error",
                        Map.of(
                                "type", exception.getClass().getName(),
                                "message", rootMessage(exception),
                                "durationMs", Duration.between(startedAt, Instant.now()).toMillis()
                        )
                ));
            }
            return ResponseEntity.status(502)
                    .header(HttpHeaders.CONTENT_TYPE, "application/json")
                    .body(errorBody(exception));
        }
    }

    private boolean shouldLogExchange(String upstreamPath) {
        return LOGGED_PATHS.contains(upstreamPath);
    }

    private Map<String, Object> sanitizedHeaders(HttpServletRequest request) {
        var headers = new LinkedHashMap<String, Object>();
        Enumeration<String> names = request.getHeaderNames();
        while (names.hasMoreElements()) {
            var name = names.nextElement();
            var normalized = name.toLowerCase(Locale.ROOT);
            headers.put(normalized, SENSITIVE_HEADERS.contains(normalized) ? "[redacted]" : request.getHeader(name));
        }
        return headers;
    }

    private Map<String, List<String>> requestHeaders(HttpServletRequest request) {
        var headers = new LinkedHashMap<String, List<String>>();
        Enumeration<String> names = request.getHeaderNames();
        while (names.hasMoreElements()) {
            var name = names.nextElement();
            var values = new ArrayList<String>();
            Enumeration<String> requestValues = request.getHeaders(name);
            while (requestValues.hasMoreElements()) {
                values.add(requestValues.nextElement());
            }
            headers.put(name, values);
        }
        return headers;
    }

    private Map<String, Object> sanitizedHeaders(Map<String, List<String>> headers) {
        var sanitized = new LinkedHashMap<String, Object>();
        headers.forEach((name, values) -> {
            var normalized = name.toLowerCase(Locale.ROOT);
            sanitized.put(name, SENSITIVE_HEADERS.contains(normalized) ? "[redacted]" : values);
        });
        return sanitized;
    }

    private Object parseJsonOrText(String body) {
        if (!StringUtils.hasText(body)) {
            return "";
        }
        try {
            return objectMapper.readTree(body);
        } catch (Exception ignored) {
            return body;
        }
    }

    private ResponseEntity<String> responseEntity(
            int status,
            Map<String, List<String>> upstreamHeaders,
            String responseBody
    ) {
        var headers = new HttpHeaders();
        upstreamHeaders.forEach((name, values) -> {
            if (isForwardableResponseHeader(name)) {
                headers.put(name, values);
            }
        });
        return ResponseEntity.status(status)
                .headers(headers)
                .body(responseBody);
    }

    private boolean isForwardableResponseHeader(String name) {
        if (!StringUtils.hasText(name) || !VALID_HTTP_HEADER_NAME.matcher(name).matches()) {
            return false;
        }
        var normalized = name.toLowerCase(Locale.ROOT);
        return !HOP_BY_HOP_HEADERS.contains(normalized) && !SENSITIVE_HEADERS.contains(normalized);
    }

    private String errorBody(Exception exception) {
        try {
            return objectMapper.writeValueAsString(Map.of(
                    "error", Map.of(
                            "message", rootMessage(exception),
                            "type", "agent_proxy_proxy_error"
                    )
            ));
        } catch (IOException jsonException) {
            return "{\"error\":{\"message\":\"Proxy request failed.\",\"type\":\"agent_proxy_proxy_error\"}}";
        }
    }

    private String rootMessage(Throwable throwable) {
        var cursor = throwable;
        while (cursor.getCause() != null) {
            cursor = cursor.getCause();
        }
        return cursor.getMessage() != null ? cursor.getMessage() : cursor.getClass().getName();
    }

}
