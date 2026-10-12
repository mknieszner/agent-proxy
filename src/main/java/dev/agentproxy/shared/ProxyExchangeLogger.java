package dev.agentproxy.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

@Component
public class ProxyExchangeLogger {

    private final ObjectMapper objectMapper;
    private final AgentProxyProperties properties;

    public ProxyExchangeLogger(ObjectMapper objectMapper, AgentProxyProperties properties) {
        this.objectMapper = objectMapper;
        this.properties = properties;
    }

    public synchronized void append(ProxyLogEntry entry) {
        try {
            Files.createDirectories(properties.getLogDirectory());
            Files.writeString(
                    logFile(),
                    objectMapper.writeValueAsString(entry) + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND
            );
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to append proxy log entry.", exception);
        }
    }

    public synchronized List<Map<String, Object>> recent(int limit) {
        if (!Files.isDirectory(properties.getLogDirectory())) {
            return List.of();
        }

        try {
            var files = Files.list(properties.getLogDirectory())
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .sorted(Comparator.reverseOrder())
                    .toList();
            var entries = new ArrayList<Map<String, Object>>();
            for (Path file : files) {
                var lines = Files.readAllLines(file, StandardCharsets.UTF_8);
                for (int index = lines.size() - 1; index >= 0 && entries.size() < limit; index--) {
                    var line = lines.get(index);
                    if (!line.isBlank()) {
                        entries.add(objectMapper.readValue(line, Map.class));
                    }
                }
                if (entries.size() >= limit) {
                    break;
                }
            }
            return entries;
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to read proxy logs.", exception);
        }
    }

    public synchronized int clear() {
        if (!Files.isDirectory(properties.getLogDirectory())) {
            return 0;
        }

        try {
            var files = Files.list(properties.getLogDirectory())
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .toList();
            var deleted = 0;
            for (Path file : files) {
                if (Files.deleteIfExists(file)) {
                    deleted++;
                }
            }
            return deleted;
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to clear proxy logs.", exception);
        }
    }

    public synchronized int clearInteraction(String interactionId) {
        if (interactionId == null || interactionId.isBlank() || !Files.isDirectory(properties.getLogDirectory())) {
            return 0;
        }

        try {
            var files = Files.list(properties.getLogDirectory())
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .toList();
            var removed = 0;
            for (Path file : files) {
                var lines = Files.readAllLines(file, StandardCharsets.UTF_8);
                var matchingIds = new java.util.HashSet<String>();
                for (String line : lines) {
                    if (line.isBlank()) {
                        continue;
                    }
                    var entry = objectMapper.readValue(line, Map.class);
                    if (interactionId.equals(interactionId(entry))) {
                        matchingIds.add(String.valueOf(entry.get("id")));
                    }
                }

                var kept = new ArrayList<String>();
                for (String line : lines) {
                    if (line.isBlank()) {
                        continue;
                    }
                    var entry = objectMapper.readValue(line, Map.class);
                    if (matchingIds.contains(String.valueOf(entry.get("id")))) {
                        removed++;
                    } else {
                        kept.add(line);
                    }
                }

                Files.write(file, kept, StandardCharsets.UTF_8);
            }
            return removed;
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to clear proxy interaction logs.", exception);
        }
    }

    public synchronized int clearExchanges(List<String> exchangeIds) {
        if (exchangeIds == null || exchangeIds.isEmpty() || !Files.isDirectory(properties.getLogDirectory())) {
            return 0;
        }
        var ids = new java.util.HashSet<>(exchangeIds);
        ids.remove(null);
        ids.remove("");
        try (var paths = Files.list(properties.getLogDirectory())) {
            var files = paths.filter(path -> path.getFileName().toString().endsWith(".jsonl")).toList();
            var removed = 0;
            for (Path file : files) {
                var kept = new ArrayList<String>();
                var removedFromFile = 0;
                for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                    if (!line.isBlank() && ids.contains(String.valueOf(objectMapper.readValue(line, Map.class).get("id")))) {
                        removedFromFile++;
                    } else {
                        kept.add(line);
                    }
                }
                if (removedFromFile > 0) Files.write(file, kept, StandardCharsets.UTF_8);
                removed += removedFromFile;
            }
            return removed;
        } catch (IOException exception) {
            throw new IllegalStateException("Failed to clear proxy exchange logs.", exception);
        }
    }

    private String interactionId(Map<String, Object> entry) {
        var payload = entry.get("payload");
        if (!(payload instanceof Map<?, ?> payloadMap)) {
            return "";
        }
        var headers = payloadMap.get("headers");
        if (!(headers instanceof Map<?, ?> headersMap)) {
            return "";
        }
        var value = header(headersMap, "x-interaction-id");
        if (value instanceof List<?> values && !values.isEmpty()) {
            return String.valueOf(values.getFirst());
        }
        return value != null ? String.valueOf(value) : "";
    }

    private Object header(Map<?, ?> headers, String expectedName) {
        for (var entry : headers.entrySet()) {
            if (expectedName.equalsIgnoreCase(String.valueOf(entry.getKey()))) {
                return entry.getValue();
            }
        }
        return null;
    }

    private Path logFile() {
        return properties.getLogDirectory().resolve(LocalDate.now() + ".jsonl");
    }
}
