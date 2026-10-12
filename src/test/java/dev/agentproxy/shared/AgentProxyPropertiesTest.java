package dev.agentproxy.shared;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AgentProxyPropertiesTest {

    @Test
    void defaultsToOpenAiUpstream() {
        var properties = new AgentProxyProperties();

        assertThat(properties.getEffectiveOpenAiCompatibleBaseUrl()).isEqualTo("https://api.openai.com");
    }

    @Test
    void newOpenAiCompatibleSettingsOverrideLegacyAliases() {
        var properties = new AgentProxyProperties();
        properties.setModelProviderBaseUrl("https://legacy.example");
        properties.setModelProviderApiKey("legacy-key");
        properties.getOpenAiCompatible().setBaseUrl("https://new.example");
        properties.getOpenAiCompatible().setApiKey("new-key");

        assertThat(properties.getEffectiveOpenAiCompatibleBaseUrl()).isEqualTo("https://new.example");
        assertThat(properties.getEffectiveOpenAiCompatibleApiKey()).isEqualTo("new-key");
    }

    @Test
    void legacyOpenAiCompatibleSettingsAreStillSupported() {
        var properties = new AgentProxyProperties();
        properties.setModelProviderBaseUrl("https://legacy.example");
        properties.setModelProviderApiKey("legacy-key");

        assertThat(properties.getEffectiveOpenAiCompatibleBaseUrl()).isEqualTo("https://legacy.example");
        assertThat(properties.getEffectiveOpenAiCompatibleApiKey()).isEqualTo("legacy-key");
    }
}
