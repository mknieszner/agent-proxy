package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OpenAiCompatController {

    private final OpenAiProxyService proxyService;

    public OpenAiCompatController(OpenAiProxyService proxyService) {
        this.proxyService = proxyService;
    }

    @GetMapping("/v1/models")
    ResponseEntity<String> models(HttpServletRequest request) {
        return proxyService.proxyGet("/v1/models", request);
    }

    @PostMapping("/v1/chat/completions")
    ResponseEntity<String> chatCompletions(HttpServletRequest request, @RequestBody JsonNode body) {
        return proxyService.proxyPost("/v1/chat/completions", request, body);
    }

    @PostMapping("/v1/responses")
    ResponseEntity<String> responses(HttpServletRequest request, @RequestBody JsonNode body) {
        return proxyService.proxyPost("/v1/responses", request, body);
    }

}
