package dev.agentproxy.openai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.agentproxy.shared.ProxyExchangeLogger;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class CopilotProxyIntegrationTest {

    private static final BlockingQueue<CapturedRequest> requests = new LinkedBlockingQueue<>();
    private static final HttpServer upstream = startUpstream();
    private static volatile String responseBody = "{\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}";
    private static volatile String responseContentType = "application/json";
    private static volatile int responseStatus = 200;

    @TempDir
    static Path logDirectory;

    @Autowired
    MockMvc mvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    ProxyExchangeLogger logger;

    @DynamicPropertySource
    static void configureUpstream(DynamicPropertyRegistry registry) {
        registry.add("agent-proxy.openai-compatible.base-url",
                () -> "http://127.0.0.1:" + upstream.getAddress().getPort());
        registry.add("agent-proxy.openai-compatible.api-key", () -> "test-upstream-key");
        registry.add("agent-proxy.log-directory", () -> logDirectory.toString());
    }

    @BeforeEach
    void resetUpstream() {
        requests.clear();
        responseBody = "{\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}";
        responseContentType = "application/json";
        responseStatus = 200;
    }

    @AfterAll
    static void stopUpstream() {
        upstream.stop(0);
    }

    @Test
    void forwardsCopilotHistoryAndToolsUsingServerKeyAndLogsExchange() throws Exception {
        var body = """
                {
                  "model":"custom-model",
                  "input":[
                    {"role":"system","content":"Follow the project rules."},
                    {"type":"function_call","call_id":"call-1","name":"read_file","arguments":"{}"},
                    {"type":"function_call_output","call_id":"call-1","output":"file contents"},
                    {"role":"user","content":"Summarize"}
                  ],
                  "tools":[{"type":"function","name":"read_file","parameters":{"type":"object"}}],
                  "tool_choice":"auto",
                  "parallel_tool_calls":true,
                  "custom_parameter":{"enabled":true}
                }
                """;
        mvc.perform(post("/v1/responses?trace=1")
                        .contentType("application/json")
                        .header("Authorization", "Bearer client-placeholder")
                        .header("openai-project", "project-1")
                        .header("X-Interaction-Id", "copilot-integration")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(content().string(responseBody))
                .andExpect(header().string("x-upstream-test", "preserved"))
                .andExpect(header().doesNotExist("set-cookie"));

        var captured = requests.poll(2, TimeUnit.SECONDS);
        assertThat(captured).isNotNull();
        assertThat(captured.method()).isEqualTo("POST");
        assertThat(captured.uri()).isEqualTo("/v1/responses?trace=1");
        assertThat(objectMapper.readTree(captured.body())).isEqualTo(objectMapper.readTree(body));
        assertThat(captured.authorization()).isEqualTo("Bearer test-upstream-key");
        assertThat(captured.project()).isEqualTo("project-1");
        assertThat(captured.interactionId()).isNull();

        var entries = logger.recent(100);
        var requestEntry = entries.stream().filter(entry -> {
            var json = objectMapper.valueToTree(entry);
            return "copilot-integration".equals(json.path("payload").path("headers").path("x-interaction-id").asText());
        }).findFirst().orElseThrow();
        var requestJson = objectMapper.valueToTree(requestEntry);
        assertThat(requestJson.path("payload").path("body")).isEqualTo(objectMapper.readTree(body));
        assertThat(requestJson.path("payload").path("headers").path("authorization").asText()).isEqualTo("[redacted]");
        assertThat(requestJson.path("payload").path("toolsCount").asInt()).isEqualTo(1);
        assertThat(entries).anySatisfy(entry -> {
            assertThat(entry.get("id")).isEqualTo(requestEntry.get("id"));
            assertThat(entry.get("kind")).isEqualTo("proxy-response");
        });
        assertThat(objectMapper.writeValueAsString(entries)).doesNotContain("client-placeholder", "test-upstream-key");
    }

    @Test
    void returnsAndLogsResponsesTextSseWithoutChangingEvents() throws Exception {
        responseContentType = "text/event-stream";
        responseBody = """
                event: response.output_text.delta
                data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello"}

                event: response.completed
                data: {"type":"response.completed","response":{"id":"resp-text","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}

                """;
        mvc.perform(post("/v1/responses")
                        .contentType("application/json")
                        .content("{\"model\":\"custom-model\",\"stream\":true,\"input\":\"Read the file\"}"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/event-stream"))
                .andExpect(content().string(responseBody));

        assertThat(requests.poll(2, TimeUnit.SECONDS)).isNotNull();
        assertThat(requests).isEmpty();
        assertThat(logger.recent(100)).anySatisfy(entry -> {
            JsonNode json = objectMapper.valueToTree(entry);
            assertThat(json.path("kind").asText()).isEqualTo("proxy-response");
            assertThat(json.path("payload").path("body").asText()).isEqualTo(responseBody);
            assertThat(json.path("payload").path("complete").asBoolean()).isTrue();
        });
    }

    @Test
    void forwardsModelDiscoveryWithoutLoggingIt() throws Exception {
        var logCount = logger.recent(100).size();
        responseBody = "{\"object\":\"list\",\"data\":[{\"id\":\"custom-model\",\"object\":\"model\"}]}";

        mvc.perform(get("/v1/models?limit=1"))
                .andExpect(status().isOk())
                .andExpect(content().string(responseBody));

        var captured = requests.poll(2, TimeUnit.SECONDS);
        assertThat(captured).isNotNull();
        assertThat(captured.method()).isEqualTo("GET");
        assertThat(captured.uri()).isEqualTo("/v1/models?limit=1");
        assertThat(logger.recent(100)).hasSize(logCount);
    }

    @Test
    void forwardsResponsesReasoningAndToolRoundTripWithoutChangingHistory() throws Exception {
        var firstBody = """
                {
                  "model":"gpt-5.6-terra",
                  "instructions":"Read the project name using the tool.",
                  "input":[{"role":"user","content":[{"type":"input_text","text":"What is the project name?"}]}],
                  "reasoning":{"effort":"medium"},
                  "tools":[{"type":"function","name":"read_project_name","parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false},"strict":true}],
                  "tool_choice":"auto",
                  "parallel_tool_calls":true,
                  "include":["reasoning.encrypted_content"],
                  "store":false,
                  "max_output_tokens":1000
                }
                """;
        responseBody = """
                {"id":"resp-1","object":"response","status":"completed","model":"gpt-5.6-terra",
                 "output":[{"type":"reasoning","id":"rs-1","encrypted_content":"encrypted-state","summary":[]},
                           {"type":"function_call","id":"fc-1","call_id":"call-1","name":"read_project_name","arguments":"{}","status":"completed"}],
                 "usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}
                """;
        mvc.perform(post("/v1/responses?trace=responses")
                        .contentType("application/json")
                        .header("Authorization", "Bearer client-placeholder")
                        .header("openai-project", "project-1")
                        .header("X-Interaction-Id", "responses-roundtrip")
                        .content(firstBody))
                .andExpect(status().isOk())
                .andExpect(content().string(responseBody))
                .andExpect(header().string("x-upstream-test", "preserved"));

        var firstRequest = requests.poll(2, TimeUnit.SECONDS);
        assertThat(firstRequest).isNotNull();
        assertThat(firstRequest.uri()).isEqualTo("/v1/responses?trace=responses");
        assertThat(firstRequest.authorization()).isEqualTo("Bearer test-upstream-key");
        assertThat(firstRequest.project()).isEqualTo("project-1");
        assertThat(objectMapper.readTree(firstRequest.body())).isEqualTo(objectMapper.readTree(firstBody));

        var followUp = (com.fasterxml.jackson.databind.node.ObjectNode) objectMapper.readTree(firstBody);
        var input = (com.fasterxml.jackson.databind.node.ArrayNode) followUp.get("input");
        objectMapper.readTree(responseBody).path("output").forEach(input::add);
        input.add(objectMapper.readTree("""
                {"type":"function_call_output","call_id":"call-1","output":"agent-proxy"}
                """));
        responseBody = """
                {"id":"resp-2","object":"response","status":"completed","model":"gpt-5.6-terra",
                 "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"agent-proxy"}]}]}
                """;
        mvc.perform(post("/v1/responses").contentType("application/json")
                        .header("X-Interaction-Id", "responses-roundtrip")
                        .content(objectMapper.writeValueAsString(followUp)))
                .andExpect(status().isOk()).andExpect(content().string(responseBody));
        assertThat(objectMapper.readTree(requests.poll(2, TimeUnit.SECONDS).body())).isEqualTo(followUp);
        assertThat(requests).isEmpty();

        var firstJson = objectMapper.readTree(firstBody);
        var loggedRequests = logger.recent(100).stream().map(objectMapper::<JsonNode>valueToTree)
                .filter(entry -> "responses-roundtrip".equals(entry.path("payload").path("headers").path("x-interaction-id").asText()))
                .toList();
        assertThat(loggedRequests).hasSize(2);
        assertThat(loggedRequests).anySatisfy(entry -> {
            assertThat(entry.path("payload").path("body")).isEqualTo(firstJson);
            assertThat(entry.path("payload").path("headers").path("authorization").asText()).isEqualTo("[redacted]");
            assertThat(entry.path("payload").path("toolsCount").asInt()).isEqualTo(1);
        });
        for (var entry : loggedRequests) {
            assertThat(logger.recent(100)).anySatisfy(response -> {
                assertThat(response.get("id")).isEqualTo(entry.path("id").asText());
                assertThat(response.get("kind")).isEqualTo("proxy-response");
            });
        }
        assertThat(objectMapper.writeValueAsString(logger.recent(100))).doesNotContain("client-placeholder", "test-upstream-key");
    }

    @Test
    void preservesResponsesSseWithReasoningToolCallsAndUsage() throws Exception {
        responseContentType = "text/event-stream";
        responseBody = """
                event: response.created
                data: {"type":"response.created","response":{"id":"resp-sse","model":"gpt-5.6-terra","status":"in_progress"}}

                event: response.output_item.added
                data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs-1","summary":[]}}

                event: response.reasoning_summary_text.delta
                data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Read the project name."}

                event: response.output_item.added
                data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"read_project_name","arguments":""}}

                event: response.function_call_arguments.delta
                data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc-1","delta":"{}"}

                event: response.output_item.done
                data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"read_project_name","arguments":"{}"}}

                event: response.completed
                data: {"type":"response.completed","response":{"id":"resp-sse","model":"gpt-5.6-terra","status":"completed","output":[{"type":"reasoning","id":"rs-1","encrypted_content":"encrypted-state","summary":[]},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"read_project_name","arguments":"{}"}],"usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}}

                """;
        mvc.perform(post("/v1/responses").contentType("application/json")
                        .header("X-Interaction-Id", "responses-sse")
                        .content("{\"model\":\"gpt-5.6-terra\",\"input\":\"Read the name\",\"stream\":true,\"reasoning\":{\"effort\":\"medium\"}}"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/event-stream"))
                .andExpect(content().string(responseBody));
        assertThat(requests.poll(2, TimeUnit.SECONDS)).isNotNull();
        assertThat(requests).isEmpty();
        assertThat(logger.recent(100)).anySatisfy(entry -> {
            var json = objectMapper.valueToTree(entry);
            assertThat(json.path("kind").asText()).isEqualTo("proxy-response");
            assertThat(json.path("payload").path("body").asText()).isEqualTo(responseBody);
        });
    }

    @Test
    void returnsUpstreamErrorsUnchangedWithoutRetry() throws Exception {
        responseStatus = 400;
        responseBody = "{\"error\":{\"message\":\"Invalid parameter\",\"type\":\"invalid_request_error\",\"param\":\"reasoning\"}}";
        mvc.perform(post("/v1/responses").contentType("application/json").content("{\"model\":\"gpt-5.6-terra\"}"))
                .andExpect(status().isBadRequest()).andExpect(content().string(responseBody));
        assertThat(requests.poll(2, TimeUnit.SECONDS)).isNotNull();
        assertThat(requests).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"failed", "incomplete", "queued"})
    void preservesResponsesLifecycleStatusesWithoutRetry(String lifecycleStatus) throws Exception {
        responseBody = "{\"id\":\"resp-status\",\"object\":\"response\",\"status\":\"" + lifecycleStatus + "\",\"output\":[]}";
        mvc.perform(post("/v1/responses").contentType("application/json").content("{\"input\":\"hello\"}"))
                .andExpect(status().isOk()).andExpect(content().string(responseBody));
        assertThat(requests.poll(2, TimeUnit.SECONDS)).isNotNull();
        assertThat(requests).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"/v1/chat/completions", "/v1/messages", "/anthropic/v1/messages", "/v1/messages/count_tokens",
            "/anthropic/v1/messages/count_tokens"})
    void removedProtocolsHaveNoPostEndpoint(String path) throws Exception {
        mvc.perform(post(path).contentType("application/json").content("{}"))
                .andExpect(status().isNotFound());
        assertThat(requests).isEmpty();
    }

    @Test
    void removedModelDiscoveryHasNoEndpoint() throws Exception {
        mvc.perform(get("/anthropic/v1/models")).andExpect(status().isNotFound());
        assertThat(requests).isEmpty();
    }

    private static HttpServer startUpstream() {
        try {
            var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                requests.add(new CapturedRequest(
                        exchange.getRequestMethod(),
                        exchange.getRequestURI().toString(),
                        new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8),
                        exchange.getRequestHeaders().getFirst("authorization"),
                        exchange.getRequestHeaders().getFirst("openai-project"),
                        exchange.getRequestHeaders().getFirst("x-interaction-id")
                ));
                var bytes = responseBody.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("content-type", responseContentType);
                exchange.getResponseHeaders().set("x-upstream-test", "preserved");
                exchange.getResponseHeaders().set("set-cookie", "upstream-secret=hidden");
                exchange.sendResponseHeaders(responseStatus, bytes.length);
                try (var output = exchange.getResponseBody()) {
                    output.write(bytes);
                }
            });
            server.start();
            return server;
        } catch (IOException exception) {
            throw new IllegalStateException("Cannot start test upstream.", exception);
        }
    }

    private record CapturedRequest(String method, String uri, String body, String authorization,
                                   String project, String interactionId) {
    }
}
