# JobMatch AI

**Smart Chrome Extension for Job Seekers** — Analyze job postings against your resume using AI, get match scores, extract salary & location data, auto-fill applications, and track every job you apply to.

![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)
![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet)
![License](https://img.shields.io/badge/License-MIT-blue)

<p align="center">
  <img src="screenshots/side-panel.png" alt="JobMatch AI analyzing a Greenhouse job posting" width="900">
</p>
<p align="center"><em>Side panel analyzing a Senior Software Engineer role on Greenhouse — extracting job details, location, and salary in real time.</em></p>

---

## Features

### Resume Analysis & Job Matching
Upload your resume (PDF or DOCX) and let AI parse it into a structured profile. When you visit any job posting, click **Analyze Job** to get:
- **Match Score** (0-100) with color-coded indicator
- **Matching Skills** — what you already have
- **Missing Skills** — gaps to address
- **Recommendations** — how to improve your fit
- **ATS Keywords** — terms to include in your application

<p align="center">
  <img src="screenshots/analysis.png" alt="Analysis results with matching skills" width="900">
</p>
<p align="center"><em>Detailed analysis results — matching skills highlighted in green, with actionable recommendations and ATS keywords to boost your application.</em></p>

### Salary & Location Extraction
Automatically detects salary ranges and job location from the posting — works on LinkedIn, Indeed, Glassdoor, Greenhouse, Lever, Workday, and more. Falls back to regex pattern matching when structured data isn't available.

### Smart Auto-Fill
Scans application forms and fills them intelligently using your profile and pre-configured Q&A answers. Handles:
- Text inputs and textareas
- Native `<select>` dropdowns
- Custom dropdowns (React, Angular, etc.)
- Radio buttons and checkboxes

### Applied Jobs Tracker
Mark jobs as "Applied" directly from the side panel. Track all your applications in one place with score, company, location, salary, and date.

<p align="center">
  <img src="screenshots/applied-jobs.png" alt="Applied Jobs tracker" width="900">
</p>
<p align="center"><em>Applied Jobs tab — track every application with color-coded match scores, company details, and one-click delete.</em></p>

### Consistent Scores
Analysis results are cached per URL and use deterministic AI settings (temperature=0), so you get the same score every time for the same job posting. Click **Re-Analyze** to force a fresh evaluation.

---

## Installation

1. **Download** or clone this repository:
   ```bash
   git clone https://github.com/wadekarg/JobMatchAI.git
   ```

2. Open Chrome (or any Chromium browser) and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle in top-right corner)

4. Click **Load unpacked** and select the `JobMatchAI` folder

5. Pin the extension from the puzzle icon in Chrome's toolbar for easy access

---

## Getting Started

### 1. Configure AI Provider

Click the extension icon → **AI Settings** (or use the side panel's **Settings** nav link).

- Select your AI provider (Anthropic/Claude recommended)
- Enter your API key
- Choose a model
- Click **Test Connection** to verify
- Click **Save Settings**

### 2. Upload Your Resume

Go to the **Profile** tab and drag & drop your resume (PDF or DOCX). AI will parse it into structured fields that you can review and edit:

<p align="center">
  <img src="screenshots/profile.png" alt="Profile page with resume loaded" width="900">
</p>
<p align="center"><em>Profile page after uploading a resume — AI automatically extracts your name, contact info, skills, experience, and more. A green checkmark confirms your resume is loaded.</em></p>

### 3. Pre-fill Q&A Answers (Optional)

Go to the **Q&A** tab and click **Load Common US Job Application Questions** to pre-fill answers for:
- Work authorization
- Availability & start date
- Salary expectations
- Background checks
- Demographics (EEO)
- And more...

These answers are used during auto-fill to instantly complete application forms.

---

## Usage

### Analyzing a Job Posting

1. Navigate to any job posting (LinkedIn, Indeed, Greenhouse, Lever, etc.)
2. Click the **star toggle button** (bottom-right corner) to open the side panel
3. Click **Analyze Job**
4. Review your match score, skill gaps, and recommendations
5. Click **Save Job** to bookmark it, or **Mark as Applied** to track it

### Auto-Filling Applications

1. Navigate to a job application form
2. Open the side panel
3. Click **AutoFill Application**
4. The extension scans the form, sends fields to AI, and fills everything — dropdowns, text fields, radio buttons, checkboxes
5. **Always review** the filled fields before submitting

### Tracking Applied Jobs

1. After analyzing a job, click **Mark as Applied** in the side panel
2. Open **Profile → Applied Jobs** tab to see all your applications
3. Each entry shows the match score, job title (linked to posting), company, location, salary, and date applied
4. Click **Delete** to remove any entry

---

## Supported Job Sites

| Site | JD Extraction | Salary | Location | Auto-Fill |
|------|:---:|:---:|:---:|:---:|
| LinkedIn | Yes | Yes | Yes | Yes |
| Indeed | Yes | Yes | Yes | Yes |
| Glassdoor | Yes | Yes | Yes | Yes |
| Greenhouse | Yes | Yes | Yes | Yes |
| Lever | Yes | Yes | Yes | Yes |
| Workday | Yes | Yes | Yes | Yes |
| Generic sites | Yes* | Yes* | Yes* | Yes |

\* *Uses generic selectors and regex fallbacks for sites without dedicated support.*

---

## Side Panel Navigation

The side panel includes quick-access nav links below the header:
- **Profile** — manage your resume and personal info
- **Q&A** — configure application answers
- **Settings** — AI provider configuration

Clicking any link opens the full Profile page directly on that tab.

---

## Project Structure

```
JobMatchAI/
├── manifest.json            # Chrome MV3 manifest
├── background.js            # Service worker: message routing, AI calls, storage
├── content.js               # Side panel UI, job scraping, autofill, applied tracker
├── aiService.js             # AI provider abstraction (API calls, prompt builders)
├── deterministicMatcher.js  # Rule-based dropdown matching (no AI needed)
├── popup.html / popup.js    # Extension toolbar popup
├── profile.html / profile.js # Profile, Q&A, Applied Jobs, Settings page
├── styles.css               # Content script base styles
├── icons/                   # Extension icons (16, 48, 128px)
├── libs/                    # pdf.js & mammoth.js for client-side resume parsing
└── screenshots/             # README images
```

---

## Contributing

JobMatch AI is **free and open source** — built to help job seekers spend less time on repetitive tasks and more time landing the right role. If you find it useful, consider giving it a star!

Contributions are welcome and encouraged. Whether it's fixing a bug, adding support for a new job site, improving the UI, or suggesting a feature — all help is appreciated.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-improvement`)
3. Commit your changes (`git commit -m "Add my improvement"`)
4. Push to the branch (`git push origin feature/my-improvement`)
5. Open a Pull Request

If you have ideas but aren't sure where to start, open an [issue](https://github.com/wadekarg/JobMatchAI/issues) — happy to discuss.

---

## Privacy

- Your resume data and API keys are stored **locally** in Chrome's storage — nothing is sent to any server except the AI provider you configure.
- Job analysis is performed via direct API calls to your chosen AI provider.
- No analytics, no tracking, no data collection.

---

## License

MIT
