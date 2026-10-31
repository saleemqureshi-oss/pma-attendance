# PMA Attendance

Attendance for the madarsah: 5 teachers, about 100 students, Monday to Friday from 5:30 PM.
Teachers mark **Present, Late or Absent** with optional remarks. All data is stored on the server.

## Demo sign-ins

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Male teachers | `ahmed`, `bilal`, `hamza` | `teacher123` |
| Female teachers | `aisha`, `maryam` | `teacher123` |

These passwords are visible to anyone who can read this repository. Before a site goes online,
set `PMA_ADMIN_PASSWORD` and `PMA_TEACHER_PASSWORD` on the host. They are used once, the first time
the site starts, and replace the demo passwords above. Afterwards, change passwords in the app
(My account, and Teachers > Edit), and give each teacher their own.

## Going from demo to real use

1. Settings: **Remove sample data**.
2. Teachers: rename each teacher and set new usernames and passwords.
3. Students: add them, or use **Import CSV** (a template is in the dialog).

The timezone is already set to Saskatoon (`America/Regina`). The 5:30 PM lock depends on it, and it can be changed in Settings.

Teachers can only mark on class days from the start time until midnight. To let someone try
the app at another time, turn off "Lock teacher marking to the schedule" in Settings.

## Run on this computer

```bash
node server.mjs
```

Open http://localhost:3000. Data is saved in the `data` folder.

## Deploy to Netlify (demo)

### From GitHub (redeploys on every push)

1. In Netlify choose **Add new project > Import an existing project > GitHub**, and pick this repository.
2. Under environment variables, add `PMA_ADMIN_PASSWORD` and `PMA_TEACHER_PASSWORD`.
3. Keep the detected settings, which come from `netlify.toml`, and deploy.

### From this computer

Netlify Drop (drag and drop) will not work, because the server part must be built. Use the CLI:

```bash
npx netlify-cli login
```

```bash
npx netlify-cli deploy --site-name pma-attendance --prod
```

If the name is taken, choose another. Data is kept in Netlify Blobs, and no database setup is needed.

## Deploy to web hosting (later)

Your hosting must support **Node.js 18 or newer**. In cPanel look for "Setup Node.js App".
Basic PHP-only hosting cannot run this version of the server.

1. Upload everything except `node_modules`, `.netlify` and `data`.
2. Create a Node.js app with `server.mjs` as the startup file. No `npm install` is needed.
3. Optionally set `DATA_DIR` to a folder outside the website, and back that folder up regularly.

Serve the site over HTTPS. Demo data on Netlify does not move across automatically.

## Tests

```bash
npm test
```

## Project layout

- `public/`: the website (no build step)
- `lib/core.mjs`: API, sign-in, permissions and schedule rules
- `lib/seed.mjs`: first-run sample data
- `lib/store-file.mjs`: file storage for ordinary hosting
- `netlify/functions/api.mjs`: Netlify entry, using Netlify Blobs
- `server.mjs`: entry for any Node.js host
