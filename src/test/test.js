#!/usr/bin/env node --use_strict

import 'source-map-support/register';

var pgp = require('pg-promise')();

import PgQueryObserver from '../..';


const connection = 'postgres://localhost/app';

async function start() {
  try {
    let db = await pgp(connection);

    let query_observer = new PgQueryObserver(db, 'myappx', { keyfield: 'id' });

    async function cleanupAndExit() {
      await query_observer.cleanup();
      pgp.end();
      process.exit();
    }

    process.on('SIGTERM', cleanupAndExit);
    process.on('SIGINT', cleanupAndExit);

    // Show notifications

    let query = `
      SELECT *
      FROM test
      WHERE id < $[id]
    `;
    let params = { id: 3 };

    function triggers(change) {
      console.log("triggers", change);
      return true;
    }

    let handle = await query_observer.notify(query, params, triggers, diff => {
      console.log(diff);
    });

    console.log("initial rows", handle.getRows());

    // ... when finished observing the query

    // await handle.stop();

    // ... when finished observing altogether

    // await query_observer.cleanup();
    // await pgp.end();
  }
  catch(err) {
    console.error(err);
  }
}

process.on('unhandledRejection', (err, p) => console.log(err.stack));

start();
