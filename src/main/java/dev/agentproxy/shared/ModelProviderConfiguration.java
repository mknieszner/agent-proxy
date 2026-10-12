package dev.agentproxy.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.agentproxy.openai.OpenAiCompatibleProviderClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ModelProviderConfiguration {

    @Bean
    ModelProviderClient modelProviderClient(ObjectMapper objectMapper, AgentProxyProperties properties) {
        return new OpenAiCompatibleProviderClient(objectMapper, properties);
    }
}
