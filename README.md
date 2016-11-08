# pg-query-observer
Observe PostgreSQL query for changes

# Usage
```javascript
var pgp = require('pg-promise')();

import PgQueryObserver from 'pg-query-observer';


const connection = 'postgres://localhost/db';

async function start() {
  try {
    let db = await pgp(connection);

    let query_observer = new PgQueryObserver(db, 'myapp');

    async function cleanupAndExit() {
      await query_observer.cleanup();
      pgp.end();
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

Parameter | Description
--------- | -----------
`db` | PostgreSQL db to use
`channel` | Channel for LISTEN/NOTIFY on the PostgreSQL database, cannot be used by more than one application on the same database.
`options` | Optional object containing options. See below.

Option | Description
------ | -----------
`trigger_delay` | (default 200ms): passed through to PgTableObserver.
`keyfield` | (default \_id): field to use as a unique keyfield to determine the differences.
`initial_cached` | (default true): If a query is already being observed with the same `query/params` combination, if will use the cached rows as the initial rows (e.g. with `handle.getRows()`). If your `triggers` are correctly defined this should be fine. Turn this option off to load fresh rows from the database for the initial dataset to be sure they are up to date.

# let handle = async notify(query, params, triggers, callback)

Parameter | Description
--------- | -----------
`query` | SELECT query to run and observe.
`params` | The parameters to the query, following `pg-promise`. Single values will be `$1`. Array elements will be `$1`..`$n`. Object properties will be `$*property*` where `**` is one of `()`, `[]`, `{}` or `//`. See `pg-promise` for details.
`triggers` | The triger function, see below.
`callback` | Callback function, see below.

## triggers function

This function will be called whenever there is a change to one of the underlying tables of the query.
You should determine if this change requires a rerun of the query. If so, you should return `true`.

One parameter is passed, `change`. It contains the following fields:

Field | Description
----- | -----------


## callback function

Whenever observer is triggered, the query will be reran. The callback will be called with one parameter, `diff`.
It will contain only the difference between the last time the query was run.

Diff will contain thee fields:

Field | Description
----- | -----------
`added` | array of rows that are in `new_rows`, but not in `old_rows`
`changed` | array of rows from `new_rows` existed in `old_rows` but have changed
`deleted` | array if the key's from the rows from `old_rows` that don't exist in `new_rows`

## return value

On success, returns an object as follows.

`async handle.stop()`. Call to stop the observer.

`async handle.refresh()`. Call to refresh the query.

`handle.getRows()`. Get current full set of rows.

# async cleanup()

Stop observing and cleanup triggers from the database.
