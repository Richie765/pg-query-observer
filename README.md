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

    async function cleanup_and_exit() {
      await query_observer.cleanup();
      await pgp.end();
      process.exit();
    }

    process.on('SIGTERM', cleanup_and_exit);
    process.on('SIGINT', cleanup_and_exit);

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

`options.trigger_delay`
`options.keyfield`

# let handle = async notify(query, params, triggers, callback)

`async handle.stop()`

`async handle.refresh()`

`handle.getRows()`

# async cleanup()
