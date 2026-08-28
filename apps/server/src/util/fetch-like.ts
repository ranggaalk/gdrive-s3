// Anything callable like fetch. Bun's `typeof fetch` carries extras such as
// `preconnect`, so demanding it from a caller forces every test double to be
// cast. These call sites only ever invoke the function, so that is all they ask
// for; `fetch` itself still satisfies it.

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
