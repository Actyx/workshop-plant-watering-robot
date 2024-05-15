# Prerequisites

This project is built in Typescript for the browser, but it also uses the `ax` middleware from <https://developer.actyx.com>.
You can download that software from the releases page (make sure to use at least version 2.18.1) or — if you have a working Rust installation — you can also

```sh
cargo install ax
```

We recommend having node.js version 20 installed and available in the PATH.

# How to run

As usual for an NPM project:

```sh
npm i
npm run dev
```

As part of the output you’ll see a message like this:

```
[dev:vis]   VITE v5.0.12  ready in 228 ms
[dev:vis] 
[dev:vis]   ➜  Local:   http://localhost:5173/
```

Open your browser at the given location and you should see a completely unstyled page showing two tables (one for plants and one for robots).
Styling has been avoided to keep UI complexity minimal, since this workshop is about the peer-to-peer aspects.

If you start another app instance (e.g. using a private browser window or by running this project also on another computer in the network) you should see more plants and robots.
This may require suitable network settings to permit peer-to-peer communication or some configuration of `ax` to initiate the connection.
Please use the [Actyx NodeManager](https://developer.actyx.com/releases/node-manager/2.12.1) to check on the health and settings of your `ax` instance.

## Acknowledgements

The implementation of these libraries and the underlying theory has been supported by the Horizon Europe EU project «TaRDIS» (grant number 101093006).
