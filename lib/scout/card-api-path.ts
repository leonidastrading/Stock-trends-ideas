/** Pure (no imports, so the login proxy can use it): the one path and methods the site login lets through to the read-only card API, which checks its own token. */
export const isCardApiRequest = (pathname: string, method: string): boolean => /^\/api\/cards\/\d+$/.test(pathname) && (method === "GET" || method === "HEAD");
