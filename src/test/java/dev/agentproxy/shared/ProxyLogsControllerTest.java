package dev.agentproxy.shared;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ProxyLogsControllerTest {

    private final ProxyExchangeLogger exchangeLogger = mock(ProxyExchangeLogger.class);
    private final ProxyLogsController controller = new ProxyLogsController(exchangeLogger);

    @Test
    void clampsLimitToMinimumWhenRequestValueIsTooSmall() {
        var entry = Map.<String, Object>of("id", "1");
        when(exchangeLogger.recent(1)).thenReturn(List.of(entry));

        var response = controller.logs(0);

        assertThat(response).containsEntry("entries", List.of(entry));
        verify(exchangeLogger).recent(1);
    }

    @Test
    void clampsLimitToMaximumWhenRequestValueIsTooLarge() {
        when(exchangeLogger.recent(500)).thenReturn(List.of());

        var response = controller.logs(999);

        assertThat(response).containsEntry("entries", List.of());
        verify(exchangeLogger).recent(500);
    }

    @Test
    void returnsDeletedFilesCountWhenClearingAllLogs() {
        when(exchangeLogger.clear()).thenReturn(3);

        var response = controller.clearLogs();

        assertThat(response).containsEntry("deletedFiles", 3);
        verify(exchangeLogger).clear();
    }

    @Test
    void returnsDeletedEntriesCountWhenClearingInteractionLogs() {
        when(exchangeLogger.clearInteraction("abc-123")).thenReturn(2);

        var response = controller.clearInteractionLogs("abc-123");

        assertThat(response).containsEntry("deletedEntries", 2);
        verify(exchangeLogger).clearInteraction("abc-123");
    }

    @Test
    void deletesOnlyExplicitExchangeIds() {
        var ids = List.of("request-1", "request-2");
        when(exchangeLogger.clearExchanges(ids)).thenReturn(4);
        assertThat(controller.clearExchanges(new ProxyLogsController.ExchangeDeletion(ids)))
                .containsEntry("deletedEntries", 4);
        verify(exchangeLogger).clearExchanges(ids);
    }
}
