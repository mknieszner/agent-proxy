package dev.agentproxy.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.List;
import java.nio.file.Files;

import static org.assertj.core.api.Assertions.assertThat;

class ProxyExchangeLoggerTest {

    @TempDir
    Path tempDirectory;

    @Test
    void clearsRequestAndResponseByCopilotInteractionId() {
        var properties = new AgentProxyProperties();
        properties.setLogDirectory(tempDirectory);
        var logger = new ProxyExchangeLogger(new ObjectMapper().findAndRegisterModules(), properties);

        logger.append(entry("exchange-1", "proxy-request", Map.of(
                "headers", Map.of("x-interaction-id", "interaction-1")
        )));
        logger.append(entry("exchange-1", "proxy-response", Map.of("status", 200)));
        logger.append(entry("exchange-2", "proxy-request", Map.of(
                "headers", Map.of("x-interaction-id", "interaction-2")
        )));
        logger.append(entry("exchange-2", "proxy-response", Map.of("status", 200)));

        var removed = logger.clearInteraction("interaction-1");

        assertThat(removed).isEqualTo(2);
        assertThat(logger.recent(10))
                .extracting(entry -> String.valueOf(entry.get("id")))
                .containsOnly("exchange-2");
    }

    @Test
    void deletesOnlySelectedExchangesAcrossFilesAndKeepsOtherTurnsInSameSession() throws Exception {
        var properties = new AgentProxyProperties();
        properties.setLogDirectory(tempDirectory);
        var mapper = new ObjectMapper().findAndRegisterModules();
        var logger = new ProxyExchangeLogger(mapper, properties);
        logger.append(entry("selected", "proxy-request", Map.of("headers", Map.of("x-interaction-id", "session"))));
        logger.append(entry("kept", "proxy-request", Map.of("headers", Map.of("x-interaction-id", "session"))));
        logger.append(entry("kept", "proxy-response", Map.of("status", 200)));
        Files.writeString(tempDirectory.resolve("2000-01-01.jsonl"),
                mapper.writeValueAsString(entry("selected", "proxy-response", Map.of("status", 400))) + "\n"
                + mapper.writeValueAsString(entry("selected", "proxy-error", Map.of("attempt", 2))) + "\n");

        assertThat(logger.clearExchanges(List.of("selected", "selected"))).isEqualTo(3);
        assertThat(logger.recent(10)).extracting(value -> value.get("id")).containsExactly("kept", "kept");
        assertThat(logger.clearExchanges(List.of("missing"))).isZero();
        assertThat(logger.clearExchanges(null)).isZero();
        logger.append(entry("new", "proxy-request", Map.of()));
        assertThat(logger.recent(10)).hasSize(3);
    }

    private ProxyLogEntry entry(String id, String kind, Map<String, Object> payload) {
        return new ProxyLogEntry(id, Instant.now(), kind, payload);
    }
}
