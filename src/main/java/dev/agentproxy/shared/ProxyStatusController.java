package dev.agentproxy.shared;

import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ProxyStatusController {

    private final AgentProxyProperties properties;

    public ProxyStatusController(AgentProxyProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/v1/status")
    Map<String, Object> status() {
        return Map.of(
                "baseUrl", properties.getEffectiveOpenAiCompatibleBaseUrl(),
                "apiKeyConfigured", StringUtils.hasText(properties.getEffectiveOpenAiCompatibleApiKey()),
                "logDirectory", properties.getLogDirectory().toString()
        );
    }
}
