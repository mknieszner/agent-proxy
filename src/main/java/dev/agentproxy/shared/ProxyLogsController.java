package dev.agentproxy.shared;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.List;

@RestController
public class ProxyLogsController {

    private final ProxyExchangeLogger exchangeLogger;

    public ProxyLogsController(ProxyExchangeLogger exchangeLogger) {
        this.exchangeLogger = exchangeLogger;
    }

    @GetMapping("/v1/logs")
    Map<String, Object> logs(@RequestParam(defaultValue = "100") int limit) {
        var safeLimit = Math.max(1, Math.min(limit, 500));
        return Map.of("entries", exchangeLogger.recent(safeLimit));
    }

    @DeleteMapping("/v1/logs")
    Map<String, Object> clearLogs() {
        return Map.of("deletedFiles", exchangeLogger.clear());
    }

    @DeleteMapping("/v1/logs/interactions/{interactionId}")
    Map<String, Object> clearInteractionLogs(@PathVariable String interactionId) {
        return Map.of("deletedEntries", exchangeLogger.clearInteraction(interactionId));
    }

    @DeleteMapping("/v1/logs/exchanges")
    Map<String, Object> clearExchanges(@RequestBody ExchangeDeletion request) {
        return Map.of("deletedEntries", exchangeLogger.clearExchanges(request.ids()));
    }

    record ExchangeDeletion(List<String> ids) {}
}
