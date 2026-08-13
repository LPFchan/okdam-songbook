// Test stub for SvelteKit's $app/state (not available outside a SvelteKit app).
export const page = {
  url: new URL("http://localhost/"),
  params: {},
  route: { id: "/" },
  status: 200,
  error: null,
  data: {},
  state: {},
  form: undefined
};

export const navigating = { to: null, from: null, type: null, willUnload: false, complete: undefined, delta: undefined };

export const updated = {
  get current() {
    return false;
  },
  check: () => Promise.resolve(false)
};
