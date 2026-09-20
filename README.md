# .trycord 👋

Hey.

**Trycord is a chat/community platform.**

You can use it to talk to people, join servers, make your own servers, send messages, and generally do the normal chat-app stuff.

The part that makes Trycord a little different is that you aren't locked to one server.

You can just use the official Trycord server, or you can run your own Trycord server if you want.

That's pretty much the idea.

## 📖 Quick start

* [🟢 Just use Trycord](#-i-just-want-to-use-trycord)
* [🧩 What are all these folders?](#-so-what-are-all-these-folders)
* [🧪 Run Trycord locally](#-want-to-try-it-locally)
* [🏠 Self-host Trycord](#-self-hosting)
* [💾 Pick a database](#-which-database-do-i-use)
* [🌐 Run the web client separately](#-running-the-web-client-separately)
* [🔗 Connect to another Trycord server](#-want-to-connect-to-another-trycord-server)
* [🖥️ Desktop app](#️-desktop-app)
* [📦 Build the desktop app](#-building-the-desktop-app)
* [🔐 Security](#-security-stuff)
* [💬 What can Trycord do?](#-what-can-trycord-actually-do)
* [🗺️ Repository layout](#️-whats-inside-the-repository)
* [🌱 Branches](#-branches)
* [🤔 Why Trycord?](#-why-make-trycord)
* [🚧 Project status](#-is-it-finished)
* [🐛 Bugs](#-found-a-bug)
* [🤝 Contributing](#-want-to-help)
* [📜 License](#-license)

---

# 🟢 I just want to use Trycord

Then you don't need to install anything.

Just go here:

### https://trycord.wispbyte.app

That's the official Trycord instance for now.

You don't need to know what Node.js is.

You don't need to set up a database.

You don't need to configure a server.

Just open the site and use it.

---

# 🧩 So what are all these folders?

There are three main parts of Trycord:

```text
trycord-client
    The website

trycord-desktop
    The desktop app

trycord-server
    The backend you can run yourself
```

The easiest way to think about it is:

```text
             YOU
              │
       ┌──────┴──────┐
       │             │
     Browser       Desktop
       │             │
       └──────┬──────┘
              │
              ▼
        Trycord Server
              │
              ▼
           Database
```

The **client** is what you see and click.

The **server** is what actually handles things like:

* accounts
* messages
* servers
* channels
* permissions
* roles
* WebSockets
* database stuff

The **desktop app** is basically the Trycord client running as a proper desktop application.

The client itself does **not** own your data.

---

# 🧪 Want to try it locally?

If you're a developer and just want to run Trycord on your computer, you can get a local instance going pretty quickly.

First:

```bat
cd trycord-server
npm install
```

Make your `.env` file:

```bat
copy .env.example .env
```

Then open `.env` and set:

```env
JWT_SECRET=<your random secret>
DB_CLIENT=sqlite
DB_FILE=./dev.db
```

Need a random secret?

Run:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the result into `JWT_SECRET`.

Then:

```bat
npm run seed
npm start
```

Open:

**http://localhost:9971**

And that's it.

🎉 You now have your own local Trycord instance.

The seed command creates a demo account:

```text
Username: demo
Password: demo1234
```

That's only meant for local testing.

Please don't use that password for anything important.

---

# 🏠 Self-hosting

If you want to actually host Trycord somewhere, you can.

A VPS, dedicated server, home server, Raspberry Pi, whatever.

The server is designed to keep the important stuff on the server instead of making the client responsible for it.

Your setup can look like:

```text
Your users
    │
    ▼
Trycord client
    │
    ▼
Your Trycord server
    │
    ▼
Your database
```

You choose the database.

You choose where the server runs.

You choose the domain.

You choose who has access.

---

# 💾 Which database do I use?

If you're just testing Trycord, use SQLite.

```env
DB_CLIENT=sqlite
DB_FILE=./dev.db
```

It's basically just a database file sitting on your machine.

If you're setting up something bigger, you can use MySQL:

```env
DB_CLIENT=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=trycord
DB_USER=trycord
DB_PASSWORD=
DB_SSL=false
```

If you're thinking:

> "I don't know what MySQL is."

That's completely fine.

Use SQLite for development.

There are more server settings in:

```text
trycord-server/.env.example
```

including:

```env
JWT_SECRET=
CLIENT_ORIGIN=
TRYCORD_INSTANCE_ID=
TRYCORD_NAME=
TRYCORD_PUBLIC_URL=
GLOBAL_TRYCORD_URL=
```

Each server should have its **own** JWT secret.

Don't copy secrets from another Trycord instance.

---

# 🌐 Running the web client separately

Normally, the server can serve the web client for you.

But if you want the client and server running separately, that's supported too.

Go into the client:

```bat
cd trycord-client
npm run serve
```

By default, it runs on:

```text
http://localhost:13331
```

The client doesn't have its own database.

It just connects to a Trycord server.

For example:

```bat
set TRYCORD_API_URL=https://trycord.wispbyte.app
set TRYCORD_INSTANCE_ID=official
npm run serve
```

You can also point it at your own server.

For example:

```bat
set TRYCORD_API_URL=https://chat.example.com
npm run serve
```

The WebSocket connection is figured out automatically from the HTTP(S) address.

So you don't normally need to manually configure `ws://` or `wss://`.

---

# 🔗 Want to connect to another Trycord server?

You don't have to rebuild the client every time you change servers.

You can tell Trycord which server to use at runtime.

The client checks settings in roughly this order:

```text
?api= launch argument
        ↓
saved Server setting
        ↓
config.js / runtime configuration
        ↓
localhost default
```

For the desktop app, you can use:

```bat
Trycord.exe --api-url=https://your-server.example
```

You can also change the server from inside the app.

On the login screen, look for:

**Change**

or go to:

**Settings → Application → Test connection**

---

# 🖥️ Desktop app

Want Trycord as an actual desktop app instead of a browser tab?

That's what `trycord-desktop` is for.

It's an Electron app that uses the Trycord client.

It is **not another backend**.

Run it locally:

```bat
cd trycord-desktop
npm install
npm start
```

You can point it at another Trycord instance:

```bat
Trycord.exe --api-url=https://your-server.example
```

The desktop app still talks to the Trycord server.

Your messages don't magically move into Electron.

---

# 📦 Building the desktop app

To build the Windows version:

```bat
npm run dist
```

The output goes into:

```text
trycord-desktop/release/
```

You'll get a Windows executable there.

For actual releases, use the project's release pipeline rather than manually uploading random builds.

Before sharing an `.exe` with other people, it's also a good idea to:

* check its SHA-256 hash
* scan the actual file
* make sure you're sharing the build you intended to share

And please name it something normal.

```text
Trycord-Setup-1.0.1.exe
```

not:

```text
LanxBuild_NOT_VIRUS_FINAL_FINAL3.exe
```

😭

---

# 🔐 Security stuff

The server is the authority.

The client shouldn't be trusted to decide things like:

* whether you can access a private message
* whether you're allowed to delete something
* whether you have administrator permissions
* whether you're allowed to change someone else's data

The server checks that.

Also, please don't commit secrets to GitHub.

Especially:

```text
.env
database passwords
JWT secrets
API tokens
private keys
```

If you accidentally put a secret somewhere public, rotate it.

Don't just delete the line and assume the problem disappeared. Git has a memory. 🗿

---

# 💬 What can Trycord actually do?

Trycord is still being built, but the project is centered around things like:

* 💬 real-time chat
* 👥 users and profiles
* 💌 direct messages
* 🏠 servers
* #️⃣ channels
* 🛡️ roles and permissions
* 🔎 server discovery
* 🔔 notifications
* 🖥️ desktop support
* 🔄 desktop auto-updates
* 🏡 self-hosting

More stuff is being added as the project grows.

---

# 🗺️ What's inside the repository?

If you just want to use Trycord, you can skip this section.

If you're curious:

```text
.trycord/
│
├── trycord-client/
│   └── The web client
│
├── trycord-desktop/
│   └── The desktop application
│
└── trycord-server/
    └── The backend
```

## Server

```text
trycord-server/src/

server.js
    Starts the server

db/
    Database stuff

ws.js
    Real-time communication

middleware/
    Authentication and access checks

routes/
    API endpoints

services/
    Server-side logic
```

The server is a **modular monolith**.

In normal-person language:

> It's one server, but the code is split into sensible pieces instead of putting absolutely everything into one giant file.

I didn't split Trycord into 47 tiny services just so the architecture diagram would look impressive.

---

## Client

```text
trycord-client/

index.html
    Main application shell

styles/
    UI styling

js/
    Application logic
```

The client handles the stuff you actually interact with.

It talks to the server through HTTP and WebSockets.

---

# 🌱 Branches

The repository currently uses a few branches for different parts of the project:

| Branch    | What's in it          |
| --------- | --------------------- |
| `main`    | The whole project     |
| `server`  | Server/backend work   |
| `client`  | Client + desktop work |
| `release` | Client release work   |

If you're just downloading Trycord, you probably don't need to care about this.

---

# 🤔 Why make Trycord?

The short version:

I wanted a chat platform where **self-hosting is actually part of the idea**, instead of something bolted on years later.

You can use the normal hosted version.

Or you can say:

> "Nah, I'm running this myself."

And you can.

Your server.

Your database.

Your rules.

That's the idea behind Trycord.

---

# 🚧 Is it finished?

Nope.

It's still being worked on.

Some parts are more polished than others, and some things will probably break while new stuff is being added.

That's normal for a project that's still under active development.

If something looks weird, tell me.

If something breaks, definitely tell me.

If something breaks spectacularly, preferably tell me **before** you delete the entire server. 😭

---

# 🐛 Found a bug?

Open an issue on GitHub.

You don't need to write an essay.

Just tell me:

```text
What were you doing?
What did you expect?
What actually happened?
What version are you using?
```

A screenshot or error message is always helpful.

---

# 🤝 Want to help?

Pull requests are welcome.

If you want to fix something, improve something, or add a feature, go for it.

Just try to keep things understandable for whoever has to touch the code after you.

Future-you will thank you.

Probably.

---

# 📜 License

Check the repository's license for the actual legal details.

---

# ❤️ That's basically Trycord

If you forget everything else in this README, remember these three things:

**1.** You can just use Trycord at **https://trycord.wispbyte.app**

**2.** You can run your own Trycord server if you want.

**3.** The client is just how you connect to the server. The server is where the actual data lives.

That's it.

Welcome to Trycord. 👋
