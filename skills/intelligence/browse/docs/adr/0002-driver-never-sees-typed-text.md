# The Driver never sees typed text

The Driver may choose to type, but only a Named value, by name: the agent passes text into a Run under names such as `email` or `password`, the Driver sees an option like "type `email` into the search field", and the text itself is filled in locally after the choice. Because of this, Candidate labels can be sent to TypeSafe without redaction — redacting them made distinct controls look identical — while page text, URLs and every value the agent supplies are either redacted or never sent. A Secret value is further restricted, by code rather than by the Driver, to password fields on the Run's starting origin or a Trusted origin.

## Considered Options

- **The agent writes the text at each typing step** (every type is a Handback). Rejected: it makes typing inside a Run pointless.
- **A small generative model writes the text** (as `jev-ultrafast` does). Rejected: a second provider, and a model inventing what goes into forms.
