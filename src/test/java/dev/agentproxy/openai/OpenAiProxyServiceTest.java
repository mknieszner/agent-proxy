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

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
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
    void sendsResponsesBodyThroughModelProviderClient() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/responses");
        request.addHeader("openai-project", "project-1");
        request.addHeader("x-interaction-id", "interaction-1");
        var body = objectMapper.readTree("""
                {"model":"gpt-5.6-terra","input":"hello"}
                """);
        when(modelProviderClient.upstreamUri("/v1/responses", null))
                .thenReturn("https://provider.example/v1/responses");
        when(modelProviderClient.send(any())).thenReturn(new ProviderResponse(
                200,
                Map.of("content-type", List.of("application/json")),
                "{\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}"
        ));

        var response = service.proxyPost("/v1/responses", request, body);

        var providerRequest = ArgumentCaptor.forClass(ProviderRequest.class);
        verify(modelProviderClient).send(providerRequest.capture());
        assertThat(providerRequest.getValue().method()).isEqualTo("POST");
        assertThat(providerRequest.getValue().path()).isEqualTo("/v1/responses");
        assertThat(providerRequest.getValue().body()).isSameAs(body);
        assertThat(providerRequest.getValue().headers()).containsEntry("x-interaction-id", List.of("interaction-1"));
        assertThat(providerRequest.getValue().headers()).containsKey("openai-project");
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).contains("\"text\":\"hello\"");

        var logEntry = ArgumentCaptor.forClass(ProxyLogEntry.class);
        verify(exchangeLogger, times(2)).append(logEntry.capture());
        assertThat(logEntry.getAllValues().get(0).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("path", "/v1/responses");
        assertThat(logEntry.getAllValues().get(1).payload())
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("complete", true);
    }

    @Test
    void transportFailureReturns502AndLogsAnErrorWithoutRetry() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/responses");
        request.addHeader("Authorization", "Bearer client-secret");
        when(modelProviderClient.upstreamUri("/v1/responses", null))
                .thenReturn("https://provider.example/v1/responses");
        when(modelProviderClient.send(any())).thenThrow(new java.io.IOException("Upstream unavailable"));

        var response = service.proxyPost("/v1/responses", request,
                objectMapper.readTree("{\"input\":\"hello\"}"));

        assertThat(response.getStatusCode().value()).isEqualTo(502);
        assertThat(objectMapper.readTree(response.getBody()).path("error").path("type").asText())
                .isEqualTo("agent_proxy_proxy_error");
        assertThat(response.getBody()).contains("Upstream unavailable");
        verify(modelProviderClient).send(any());
        var entries = ArgumentCaptor.forClass(ProxyLogEntry.class);
        verify(exchangeLogger, times(2)).append(entries.capture());
        assertThat(entries.getAllValues().get(1).kind()).isEqualTo("proxy-error");
        assertThat(entries.getAllValues().get(1).id()).isEqualTo(entries.getAllValues().get(0).id());
        assertThat(objectMapper.writeValueAsString(entries.getAllValues())).doesNotContain("client-secret");
    }
}
