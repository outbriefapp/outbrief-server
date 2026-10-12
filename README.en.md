# outbrief-server

[中文](README.md)

OutBrief server. It only relays: it takes encrypted reports from outbrief-daemon, rings the clients, and queues their encrypted replies back to the daemon. The server has no key and cannot read reports, briefs, or replies. There is no login; accounts are anonymous and devices join with a pairing code.

Docs, install steps, and design decisions are on the website: **<https://outbriefapp.com/en/>**

- [Self-host the server (deploy, environment, local development)](https://outbriefapp.com/en/docs/server/)
- [Quick start (install order and pairing)](https://outbriefapp.com/en/docs/quick-start/)
- [Architecture decisions (ADR, Chinese)](https://outbriefapp.com/en/docs/adr/)

## License

[OutBrief License](LICENSE) (Apache License 2.0 plus extra terms, following the [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)).
