# pg-query-observer
Observe PostgreSQL query for changes

# Usage
```javascript
var pgp = require('pg-promise')();

import PgQueryObserver from '../..';


const connection = 'postgres://localhost/db';

async function start() {
  try {
    let db = await pgp(connection);

    let query_observer = new PgQueryObserver(db, 'myapp');

    async function cleanupAndExit() {
      await query_observer.cleanup();
      await pgp.end();
      process.exit();
    }

    process.on('SIGTERM', cleanupAndExit);
    process.on('SIGINT', cleanupAndExit);

    // Show notifications

    let query = 'SELECT id AS _id, * FROM test';
    let params = [];

    function triggers(change) {
      console.log("triggers", change);
      return true;
    }

    let handle = await query_observer.notify(query, params, triggers, diff => {
      console.log(diff);
    });

    console.log("initial rows", handle.rows);

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
```

# constructor(db, channel, [options])

`options.trigger_delay` (default 200ms): passed through to PgTableObserver.
`options.keyfield` (default \_id): field to use as a unique keyfield to determine the differences.
`options.initial_cached` (default true): If a query is already being observed with the same `query/params` combination, if will use the cached rows as the initial rows (e.g. with `handle.getRows()`). If your `triggers` are correctly defined this should be fine. Turn this option off to load fresh rows from the database for the initial dataset to be sure they are up to date.

# let handle = async notify(query, params, triggers, callback)

## parameters

`params`: The parameters to the query, following `pg-promise`. Single values will be `$1`. Array elements will be
`$1`..`$n`. Object properties will be `$*property*` where `**` is one of `()`, `[]`, `{}` or `//`.

## return value

`async handle.stop()`

`async handle.refresh()`

`handle.getRows()`

# async cleanup()
