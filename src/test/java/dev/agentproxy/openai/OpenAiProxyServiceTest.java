package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.agentproxy.shared.ModelProviderClient;
import dev.agentproxy.shared.ProviderRequest;
import dev.agentproxy.shared.ProviderResponse;
import dev.agentproxy.shared.ProxyExchangeLogger;
import dev.agentproxy.shared.ProxyLogEntry;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class OpenAiProxyServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ModelProviderClient modelProviderClient = mock(ModelProviderClient.class);
    private final ProxyExchangeLogger exchangeLogger = mock(ProxyExchangeLogger.class);
    private final OpenAiProxyService service = new OpenAiProxyService(
            objectMapper,
            modelProviderClient,
            exchangeLogger
    );

    @Test
    void sendsModelsRequestThroughModelProviderClient() throws Exception {
        var request = new MockHttpServletRequest("GET", "/v1/models");
        request.setQueryString("limit=1");
        when(modelProviderClient.upstreamUri("/v1/models", "limit=1"))
                .thenReturn("https://provider.example/v1/models?limit=1");
        when(modelProviderClient.send(any())).thenReturn(new ProviderResponse(
                200,
                Map.of("content-type", List.of("application/json")),
                "{\"data\":[]}"
        ));

        var response = service.proxyGet("/v1/models", request);

        var providerRequest = ArgumentCaptor.forClass(ProviderRequest.class);
        verify(modelProviderClient).send(providerRequest.capture());
        assertThat(providerRequest.getValue().method()).isEqualTo("GET");
        assertThat(providerRequest.getValue().path()).isEqualTo("/v1/models");
        assertThat(providerRequest.getValue().queryString()).isEqualTo("limit=1");
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isEqualTo("{\"data\":[]}");
    }

    @Test
    void sendsChatCompletionBodyThroughModelProviderClient() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/chat/completions");
        request.addHeader("openai-project", "project-1");
        request.addHeader("x-interaction-id", "interaction-1");
        var body = objectMapper.readTree("""
                {"model":"gpt-4.1","messages":[{"role":"user","content":"hello"}]}
                """);
        when(modelProviderClient.upstreamUri("/v1/chat/completions", null))
                .thenReturn("https://provider.example/v1/chat/completions");
        when(modelProviderClient.send(any())).thenReturn(new ProviderResponse(
                200,
                Map.of("content-type", List.of("application/json")),
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}"
        ));

        var response = service.proxyPost("/v1/chat/completions", request, body);

        var providerRequest = ArgumentCaptor.forClass(ProviderRequest.class);
        verify(modelProviderClient).send(providerRequest.capture());
        assertThat(providerRequest.getValue().method()).isEqualTo("POST");
        assertThat(providerRequest.getValue().path()).isEqualTo("/v1/chat/completions");
        assertThat(providerRequest.getValue().body()).isSameAs(body);
        assertThat(providerRequest.getValue().headers()).containsEntry("x-interaction-id", List.of("interaction-1"));
        assertThat(providerRequest.getValue().headers()).containsKey("openai-project");
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).contains("\"content\":\"hello\"");

        var logEntry = ArgumentCaptor.forClass(ProxyLogEntry.class);
        verify(exchangeLogger, times(2)).append(logEntry.capture());
        assertThat(logEntry.getAllValues().get(0).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("path", "/v1/chat/completions");
        assertThat(logEntry.getAllValues().get(1).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("attempt", 1)
                .containsEntry("complete", true);
    }

    @Test
    void retriesAnIncompleteEventStreamAndReturnsTheCompleteSecondAttempt() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/chat/completions");
        var body = objectMapper.readTree("""
                {"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hello"}]}
                """);
        var incompleteStream = """
                data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"filePath\\\":\\\"test.java\\\""}}]},"finish_reason":null}]}

                """;
        var completeStream = """
                data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}

                data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

                data: [DONE]

                """;
        when(modelProviderClient.upstreamUri("/v1/chat/completions", null))
                .thenReturn("https://provider.example/v1/chat/completions");
        when(modelProviderClient.send(any()))
                .thenReturn(eventStreamResponse(incompleteStream), eventStreamResponse(completeStream));

        var response = service.proxyPost("/v1/chat/completions", request, body);

        verify(modelProviderClient, times(2)).send(any());
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isEqualTo(completeStream);

        var logEntry = ArgumentCaptor.forClass(ProxyLogEntry.class);
        verify(exchangeLogger, times(3)).append(logEntry.capture());
        assertThat(logEntry.getAllValues().get(1).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("attempt", 1)
                .containsEntry("complete", false)
                .containsEntry("willRetry", true)
                .containsEntry("validationError", "SSE stream ended without a finish_reason.");
        assertThat(logEntry.getAllValues().get(2).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("attempt", 2)
                .containsEntry("complete", true);
    }

    @Test
    void returnsBadGatewayWhenBothEventStreamAttemptsAreIncomplete() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/chat/completions");
        var body = objectMapper.readTree("""
                {"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hello"}]}
                """);
        var incompleteStream = """
                data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}

                """;
        when(modelProviderClient.upstreamUri("/v1/chat/completions", null))
                .thenReturn("https://provider.example/v1/chat/completions");
        when(modelProviderClient.send(any())).thenReturn(eventStreamResponse(incompleteStream));

        var response = service.proxyPost("/v1/chat/completions", request, body);

        verify(modelProviderClient, times(2)).send(any());
        assertThat(response.getStatusCode().value()).isEqualTo(502);
        assertThat(objectMapper.readTree(response.getBody()).path("error").path("type").asText())
                .isEqualTo("agent_proxy_incomplete_upstream_response");
        assertThat(objectMapper.readTree(response.getBody()).path("error").path("message").asText())
                .contains("SSE stream ended without a finish_reason");
        verify(exchangeLogger, times(4)).append(any());
    }

    @Test
    void retriesAnEventStreamThatHasAFinishReasonButNoDoneEvent() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/chat/completions");
        var body = objectMapper.readTree("""
                {"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hello"}]}
                """);
        var incompleteStream = """
                data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}

                """;
        var completeStream = incompleteStream + "data: [DONE]\n\n";
        when(modelProviderClient.upstreamUri("/v1/chat/completions", null))
                .thenReturn("https://provider.example/v1/chat/completions");
        when(modelProviderClient.send(any()))
                .thenReturn(eventStreamResponse(incompleteStream), eventStreamResponse(completeStream));

        var response = service.proxyPost("/v1/chat/completions", request, body);

        verify(modelProviderClient, times(2)).send(any());
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isEqualTo(completeStream);

        var logEntry = ArgumentCaptor.forClass(ProxyLogEntry.class);
        verify(exchangeLogger, times(3)).append(logEntry.capture());
        assertThat(logEntry.getAllValues().get(1).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("validationError", "SSE stream ended without data: [DONE].");
    }

    @Test
    void acceptsAnEventStreamWithAUsageOnlyEmptyChoicesEvent() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/chat/completions");
        var body = objectMapper.readTree("""
                {"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hello"}]}
                """);
        var completeStream = """
                data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}

                data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}

                data: [DONE]

                """;
        when(modelProviderClient.upstreamUri("/v1/chat/completions", null))
                .thenReturn("https://provider.example/v1/chat/completions");
        when(modelProviderClient.send(any())).thenReturn(eventStreamResponse(completeStream));

        var response = service.proxyPost("/v1/chat/completions", request, body);

        verify(modelProviderClient).send(any());
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isEqualTo(completeStream);
    }

    private ProviderResponse eventStreamResponse(String body) {
        return new ProviderResponse(
                200,
                Map.of("content-type", List.of("text/event-stream; charset=utf-8")),
                body
        );
    }
}
