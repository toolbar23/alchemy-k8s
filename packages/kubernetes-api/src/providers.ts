import * as Provider from "alchemy/Provider";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "KubernetesApi",
) {}
