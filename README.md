Serverless Jetpack
==================

A faster JavaScript packager for [Serverless][] applications.

## Overview

The Serverless framework is a **fantastic** one-stop-shop for taking your code and packing up all the infrastructure around it to deploy it to the cloud. Unfortunately, for many JavaScript applications, some aspects of packaging are slow, hindering development speed and happiness.

With the `serverless-jetpack` plugin, many common, slow Serverless packaging scenarios can be dramatically sped up. All with a very easy, seamless integration into your existing Serverless projects.

## Usage

TODO_INSERT_USAGE

## How it works

The Serverless framework can sometimes massively slow down when packaging applications with large amounts / disk ussage for `devDependencies`. Although the framework enables `excludeDevDependencies` during packaging by default, just ingesting all the files that are later excluded (via that setting and normal `include|exclude` globs) causes apparently enough disk I/O to make things potentially slow.

Observing that a very common use case for a Serverless framework is:

- A `package.json` file defining production and development dependencies.
- A `yarn.lock` file if using `yarn` or a `package-lock.json` file if using `npm` to lock down and speed up installations.
- One or more JavaScript source file directories, typically something like `src`.

The `serverless-jetpack` plugin leverages this use case and gains a potentially significant speedup by observing that manually pruning development dependencies (as Serverless does) can be much, much slower in practice than using honed, battle-tested tools like `yarn` and `npm` to install just the production dependencies from scratch -- by doing a fresh `yarn|npm install` in a temporary directory, copying over source files and zipping that all up!

Process-wise, the `serverless-jetpack` plugin uses the internal logic from Serverless packaging to detect when Serverless would actually do it's own packaging. Then, it inserts its different packaging steps and copies over the analogous zip file to where Serverless would have put it, and sets internal Serverless `artifact` field that then causes Serverless to skip all its normal packaging steps.

### Complexities

**Lockfiles**

It is a best practice to use lockfiles (`yarn.lock` or `package-lock.json`) generally, and specifically important for the approach this plugin takes because it does **new** `yarn|npm` installs into a temporary directory. Without lockfiles you may be packaging/deploying something _different_ from what is in the root project.

To this end, the plugin assumes that a lockfile is provided by default and you must explicitly set the TODO_LOCKFILE_OPTION option to `null` to avoid having a lockfile copied over. When a lockfile is present then the strict (and fast!) `yarn install --frozen-lockfile  --production` and `npm ci --production` commands are used to guarantee the packaged `node_modules` matches the relevant project modules. And, the installs will **fail** (by design) if the lockfile is out of date.

**Monorepos and lockfiles**

Many projects use features like [yarn workspaces](https://yarnpkg.com/lang/en/docs/workspaces/) and/or [lerna](https://lerna.js.org/) to have a large root project that then has many separate serverless functions/packages in separate directories. In cases like these, the relevant lock file may not be in something like `packages/NAME/yarn.lock`, but instead at the project root like `yarn.lock`.

In cases like these, simply set the lockfile option TODO_LOCKFILE_OPTION to relatively point to the appropriate lockfile (e.g., `../../yarn.lock`).

**`npm install` vs `npm ci`**

`npm ci` was introduced in version [`5.7.0`](https://blog.npmjs.org/post/171139955345/v570). Notwithstanding the general lockfile logic discussed above, if the plugin detects an `npm` version prior to `5.7.0`, the non-locking, slower `npm install --production` command will be used instead.

## Benchmarks

TODO_INSERT

[Serverless]: https://serverless.com/
