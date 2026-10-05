# LineBridge design QA

Date: 2026-10-01, Asia/Taipei.

This report records an earlier design pass; the current dashboard has since been redesigned.

final result: passed

The requested Apple-inspired redesign is applied to the browser interface. The opening page is a five-step setup wizard. Monitoring and detailed settings have their own pages. No P0, P1 or P2 finding remains in the checked flows. Version 0.3 retains this interface in the headless npm service; desktop packaging was retired.

## Target and comparison method

The approved visual target is [design/wizard-reference.png](design/wizard-reference.png), generated with the built-in image generation tool. Its exact prompt is [design/wizard-prompt.md](design/wizard-prompt.md). The transparent production illustration is [design/bridge-welcome.png](design/bridge-welcome.png); its prompt and generation mode are recorded in [design/hero-prompt.md](design/hero-prompt.md).

Desktop comparisons used a 1536 × 1024 CSS viewport and the same welcome state, with no login dialog, selected personal account, or user draft. The target and final implementation both have 1536 × 1024 pixels. The first screenshot's 1521 × 1014 pixels were normalized to the target size for that pass; later final captures required no normalization. Every comparison contains the reference and implementation in one image. The full frame and a focused typography/benefits/actions region were both inspected after fixes.

- Final full-frame evidence: [design/comparison-final.png](design/comparison-final.png).
- Final focused evidence: [design/comparison-detail-final.png](design/comparison-detail-final.png).
- Raw final desktop capture: [design/wizard-implementation-final.png](design/wizard-implementation-final.png).
- User-facing app screenshot, after resetting the temporary viewport override: [design/linebridge-redesign.png](design/linebridge-redesign.png).

## Comparison history and resolved findings

| Pass | Evidence | Finding and resolution |
| --- | --- | --- |
| First | `design/comparison-first.png`, `design/comparison-detail-first.png` | P2: the card began about 12 px too low and the desktop page scrolled unnecessarily. Header/step spacing and card content height were corrected. |
| First | Same full and focused images | P2: welcome typography was smaller/lighter than the target, and subtitle wording differed. Restored the target copy, 36 px/700 heading and 20 px subtitle. |
| First | Same images | P2: benefit icon containers and palette differed; lower sidebar navigation gaps were too loose. Rounded benefit surfaces, pearl/emerald colors, 51 px navigation rows and divider/footer spacing now follow the target. |
| Second | `design/comparison-second.png`, `design/comparison-detail-second.png` | Rebuilt captures confirmed the desktop overflow and layout fixes. Platform font differences remained; added the local Noto Sans TC variable font and adjusted navigation rhythm. |
| Third | `design/comparison-third.png`, `design/comparison-detail-third.png` | Inspected both images. The card, text hierarchy, illustration, actions and sidebar alignment followed the target. |
| Final | `design/comparison-final.png`, `design/comparison-detail-final.png` | P2 accessibility check: helper text, later step labels, active navigation and primary actions were too faint. Darkened the same gray/emerald tokens, then rebuilt and re-compared both final images. All measured welcome text/control pairs now meet at least 4.5:1. |

## Final fidelity assessment

**Layout and spacing:** Pearl sidebar, restrained header, five connected progress steps, centered white card, hero, paired benefits and aligned primary/secondary actions follow the target. The desktop document is 1536 × 1024 with no horizontal or vertical overflow. Monitoring metrics and advanced controls are absent from the welcome page.

**Typography and copy:** Local Noto Sans TC variable fonts loaded successfully, with explicit heading/body hierarchy and readable line heights. Traditional Chinese copy matches the welcome target and remains coherent in subsequent steps. Contact aliases and author names replace raw IDs in the reader and inbox; unavailable names have a clear fallback. Technical chat IDs are inside an expandable details section.

**Colors and surfaces:** The gray/emerald palette, pale sidebar, white rounded card, light dividers and subtle elevation follow the reference. Slightly deeper functional text colors intentionally improve readability. Measured contrast: header copy 4.62:1, welcome subtitle and benefits 4.83:1, later step labels and footnote 4.62:1, primary button/sandbox action 4.71:1, active navigation 4.77:1 and other navigation 5.05:1. These are checks of the observed welcome state, not a claim of a complete WCAG audit.

**Assets and icons:** The welcome artwork is a real generated transparent PNG, with preserved alpha and soft shadows; no CSS or custom SVG artwork substitutes for it. It remains sharp and proportionate, without clipping or masking halos. Unmodified Phosphor regular icons are used consistently, including dialog close/refresh/add controls. Standard and WebKit mask properties are present. Icon and font files, licenses and attribution are local; there is no CDN dependency.

**Acceptable P3 differences:** The existing production LineBridge logo is retained instead of recreating the mockup's letter mark. The separately generated transparent illustration has a slightly different tile tilt, and licensed library icons replace the mockup's exact icon drawings. These differences preserve the design intent and do not reduce clarity or functionality.

## Responsive and accessibility checks

- Desktop: 1536 × 1024, no overflow; all five steps and main actions are visible.
- Tablet: 768 × 1024; compact icon navigation, full-width card, readable copy and both actions. Evidence: `design/wizard-tablet.png`.
- Narrow tablet: 601 × 900; no horizontal overflow, subtitle wraps naturally, buttons shrink to fit and the page scrolls vertically to remaining content.
- Mobile: 390 × 844 CSS viewport; no horizontal overflow, stacked actions and vertical scrolling. All six navigation controls retain their accessible names. Evidence: `design/wizard-mobile.png`.
- Keyboard: Tab from the primary action reaches the stored-account action with a visible focus outline. Forms have labels, dialogs have named close controls, the illustration has useful alt text, and the current page/step have ARIA state. Mobile actions are 46 px high and navigation rows 51 px high. Reduced-motion styles disable transitions.
- No overlap, unreadable text wrapping, disappearing actions or broken imagery was observed at the checked widths. Automated status updates preserve form drafts and do not replace unchanged account navigation while it has focus.

## Functional checks and state preservation

The walkthrough used the existing synthetic sandbox. It covered entering chat selection, filtering OpenChat with search, clearing search, proceeding to AI permissions, opening a token dialog limited to the selected account with read/send initially unchecked, closing it without issuing a token, skipping optional setup, opening the separate connection settings and returning to step four, finishing with an accurate summary and entering monitoring.

Adding a LINE account while a connected sandbox is selected keeps the wizard on step one during status polling; closing or cancelling the dialog does not advance it or create an account. The final rebuilt wizard was walked through again. The monitoring-to-chat link opens the correct sandbox reader. Chat details collapse, author names and local manual send controls remain available. Reader evidence: `design/sandbox-reader.png`. Monitoring evidence: `design/monitoring-desktop.png`.

A sandbox draft survived more than ten seconds of three-second polling and navigation away/back. One synthetic send was accepted, read back with the author `我`, and captured by sandbox monitoring. Monitoring was restored to its original off state. Existing real accounts, chat designations, monitoring settings, tokens, tunnel settings and protocol checkpoints were preserved. No live LINE message was sent, AI token issued or external tunnel activated during UI QA.

Final browser warning/error logs were empty. JavaScript syntax checks, 31 JavaScript tests, nine Rust tests, workspace clippy with warnings denied, and the isolated Rust HTTP/official MCP client smoke test passed. The final UI-only contrast adjustment was checked in the rebuilt browser interface and Windows installer.

## Verification limits

Visual and interaction QA used the in-app browser against the production Rust service. The same assets are embedded in the Tauri build, and Windows NSIS packaging succeeded; complete native WebView/installer interaction was not performed. A native macOS build and WebKit rendering remain unverified on this Windows PC. Live alias checks resolved personal/group names, but the sampled OpenChats contained no messages, so their author nickname resolution is fixture-tested rather than live-author verified. Cloudflare configuration remains pending the user's hostname choice.
