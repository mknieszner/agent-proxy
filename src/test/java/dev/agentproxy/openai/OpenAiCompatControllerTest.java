package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class OpenAiCompatControllerTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final OpenAiProxyService proxyService = mock(OpenAiProxyService.class);
    private final OpenAiCompatController controller = new OpenAiCompatController(proxyService);

    @Test
    void forwardsModelsToModelProviderUpstream() {
        var request = new MockHttpServletRequest("GET", "/v1/models");
        var expected = ResponseEntity.ok("{\"data\":[]}");
        when(proxyService.proxyGet("/v1/models", request)).thenReturn(expected);

        var actual = controller.models(request);

        assertThat(actual).isSameAs(expected);
        verify(proxyService).proxyGet("/v1/models", request);
    }

    @Test
    void forwardsResponsesBodyToModelProviderUpstream() throws Exception {
        var request = new MockHttpServletRequest("POST", "/v1/responses");
        var body = objectMapper.readTree("""
                {"model":"gpt-5.6-terra","input":"test"}
                """);
        var expected = ResponseEntity.ok("{\"object\":\"response\",\"output\":[]}");
        when(proxyService.proxyPost("/v1/responses", request, body)).thenReturn(expected);

        var actual = controller.responses(request, body);

        assertThat(actual).isSameAs(expected);
        verify(proxyService).proxyPost("/v1/responses", request, body);
    }

}
