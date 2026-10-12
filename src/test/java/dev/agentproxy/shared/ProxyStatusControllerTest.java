package dev.agentproxy.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class ProxyStatusControllerTest {

    @Test
    void exposesUpstreamConfigurationWithoutSecretValues() throws Exception {
        var properties = new AgentProxyProperties();
        properties.getOpenAiCompatible().setBaseUrl("https://provider.example");
        properties.getOpenAiCompatible().setApiKey("upstream-secret");
        properties.setLogDirectory(Path.of("custom-logs"));

        var response = new ProxyStatusController(properties).status();

        assertThat(response).containsOnlyKeys("baseUrl", "apiKeyConfigured", "logDirectory")
                .containsEntry("baseUrl", "https://provider.example")
                .containsEntry("apiKeyConfigured", true)
                .containsEntry("logDirectory", "custom-logs");
        assertThat(new ObjectMapper().writeValueAsString(response)).doesNotContain("upstream-secret");
    }

    @Test
    void reportsMissingUpstreamKey() {
        var response = new ProxyStatusController(new AgentProxyProperties()).status();

        assertThat(response).containsEntry("apiKeyConfigured", false);
    }
}
