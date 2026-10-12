package dev.agentproxy.shared;

public interface ModelProviderClient {

    String upstreamUri(String path, String queryString);

    ProviderResponse send(ProviderRequest request) throws Exception;
}
