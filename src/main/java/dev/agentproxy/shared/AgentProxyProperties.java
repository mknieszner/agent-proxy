package dev.agentproxy.shared;

import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;

@ConfigurationProperties(prefix = "agent-proxy")
public class AgentProxyProperties {

    private String modelProviderBaseUrl = "https://api.openai.com";
    private String modelProviderApiKey;
    private Path logDirectory = Path.of("logs", "agent-proxy");
    private OpenAiCompatible openAiCompatible = new OpenAiCompatible();

    public String getModelProviderBaseUrl() {
        return modelProviderBaseUrl;
    }

    public void setModelProviderBaseUrl(String modelProviderBaseUrl) {
        this.modelProviderBaseUrl = modelProviderBaseUrl;
    }

    public String getModelProviderApiKey() {
        return modelProviderApiKey;
    }

    public void setModelProviderApiKey(String modelProviderApiKey) {
        this.modelProviderApiKey = modelProviderApiKey;
    }

    public String getEffectiveOpenAiCompatibleBaseUrl() {
        return StringUtils.hasText(openAiCompatible.getBaseUrl())
                ? openAiCompatible.getBaseUrl()
                : modelProviderBaseUrl;
    }

    public String getEffectiveOpenAiCompatibleApiKey() {
        return StringUtils.hasText(openAiCompatible.getApiKey())
                ? openAiCompatible.getApiKey()
                : modelProviderApiKey;
    }

    public Path getLogDirectory() {
        return logDirectory;
    }

    public void setLogDirectory(Path logDirectory) {
        this.logDirectory = logDirectory;
    }

    public OpenAiCompatible getOpenAiCompatible() {
        return openAiCompatible;
    }

    public void setOpenAiCompatible(OpenAiCompatible openAiCompatible) {
        this.openAiCompatible = openAiCompatible;
    }

    public static class OpenAiCompatible {

        private String baseUrl;
        private String apiKey;

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getApiKey() {
            return apiKey;
        }

        public void setApiKey(String apiKey) {
            this.apiKey = apiKey;
        }
    }
}
