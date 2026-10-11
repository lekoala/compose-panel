# ADR 0016 — Navigation sidebar and stack switcher

Status: accepted.

## Context
The section links (Stacks, Containers, Server, Activity log, Access & security)
were rendered in the page footer, and reaching another stack always meant going
back to the list. On a host with more than a couple of stacks this is poor
ergonomics: the footer is a weak place for primary navigation, and the list is
the only switch between stacks.

The panel must stay light (see [product.md](../product.md)): server-rendered
HTML, minimal vanilla JS, no new backend behaviour. Improving navigation must
not require a new Docker collection, endpoint, cache or durable state.

## Decision
- **A persistent sidebar on every authenticated page**, carrying the section
  links and the list of stacks, with the current section and the current stack
  marked (`aria-current="page"`). The footer keeps the version and the access
  line only.
- **The stack list comes from `listStacks(root)` alone** — the folder names that
  are valid Compose stacks. No Docker call, no status, counter or badge in the
  sidebar. States stay in the main content, where they are already rendered.
- **One discovery per request.** The sidebar is built from a single `listStacks`
  call per authenticated page render; on the home page the discovery already done
  for the stacks table is reused. No memoisation layer is introduced.
- **Local search as progressive enhancement.** A vanilla-JS filter hides sidebar
  entries and home-table rows that do not match; without JavaScript the full list
  of links is shown, so no function is lost.
- **Responsive by CSS only.** On small screens the sidebar collapses into a
  native `<details>` disclosure. No JavaScript is required to open the menu.
- **Mobile behavior.** The sidebar renders closed everywhere. On small screens
  it opens as an overlay above the content instead of pushing it down; a small
  script opens it on wide screens and adds Escape/outside-tap dismissal on
  small ones. Without JavaScript the menu stays usable, collapsed into its
  toggle on arrival and opened with one tap. `/app.js` loads on every page
  that renders navigation (defaulted in `documentHtml`), so the drawer sync
  and the stack filter cannot be forgotten by a page.
- The `bare` pages (sign-in, session ended, error messages) are unchanged: the
  sidebar is rendered only when navigation data is supplied.

## Consequences
- Operators move between stacks without returning to the list, and primary
  navigation sits where it is read.
- The change is presentation-only: no route, invariant or Docker behaviour is
  touched, and each page adds at most one cheap directory read.
- Acknowledgeable limitation kept on purpose: the sidebar shows names only, not
  states. A global "update ready" or per-stack status in the navigation is not
  introduced, because it would force a duplicate Docker collection on every
  page. It stays in the stack detail (see [ADR 0011](0011-pull-and-update-ready.md))
  until a real need for a global view is demonstrated.
