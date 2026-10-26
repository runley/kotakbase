# Kotakbase Code Signing Policy

_Last updated: October 26, 2026_

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What gets signed

Only Kotakbase's own Windows installer and the program files built from the source code in [github.com/runley/kotakbase](https://github.com/runley/kotakbase). Every signed release is built by GitHub Actions from that public repository, so anyone can check which source a signed file came from. Nothing built on a personal computer is signed.

Third-party programs that ship inside the installer, such as mpv, are included as their authors publish them and are not signed with this certificate. They are listed in [THIRD_PARTY_NOTICES.txt](https://github.com/runley/kotakbase/blob/main/THIRD_PARTY_NOTICES.txt) and [licenses/](https://github.com/runley/kotakbase/tree/main/licenses).

## Team roles and their members

- **Committers and reviewers:** [runley](https://github.com/runley)
- **Approvers:** [runley](https://github.com/runley)

Every signing request is approved by hand by an approver before a release is published. All team members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it, with the exceptions described in the [Kotakbase Privacy Policy](privacy): show information, update checks, and the services the user chooses to use (AniList sign-in, Discord status, extensions, torrent streaming and Watch Together).

## Reporting a problem

If you find a signed file that you believe wasn't built from this project's source, or that does something this policy doesn't allow, please [open an issue](https://github.com/runley/kotakbase/issues) or contact [SignPath Foundation](https://signpath.org/).
