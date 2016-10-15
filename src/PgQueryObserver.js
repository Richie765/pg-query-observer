import { murmur3 } from 'murmurhash-js';
import _ from 'lodash';

import PgTableObserver from '../../pg-table-observer/';
import rowsDiff from '../../rows-diff/';
import tablesUsed from '../../pg-analyze/';

//
// PgQueryObserver
//

class PgQueryObserver {
  constructor(db, channel, options = {}) {
    this.db = db;
    this.channel = channel;

    this.options = options;

    if(options.initial_cached === undefined) options.initial_cached = true;

    // options.trigger_delay -> passed to PgTableObserver (default there is 200ms)
    // options.keyfield -> passed to rowsDiff and refreshQuery (default there is _id)

    this.table_observer = new PgTableObserver(db, channel);

    this.query_infos = {};
  }

  // Public Methods

  async notify(query, params, triggers, callback) {
    // Check parameters

    if(typeof query !== 'string')
      throw new TypeError('Query string missing');

    // params can be almost any type including undefined

    if(typeof triggers !== 'function')
      throw new TypeError('Triggers function missing');

    if(typeof callback !== 'function')
      throw new TypeError('Callback function missing');

    // Create or find query_info

    let hash = murmur3(JSON.stringify([ query, params ]));

    let query_info;

    if(hash in this.query_infos) {
      query_info = this.query_infos[hash];
    }
    else {
      query_info = new QueryInfo(this, query, params, hash);
      await query_info.init();
      this.query_infos[hash] = query_info;
    }

    // Create subscriber

    let subscriber = new Subscriber(query_info, triggers, callback);
    await subscriber.init();

    // Return result handle

    return {
      async stop() {
        await query_info.removeSubscriber(subscriber);
      },

      async refresh() {
        await subscriber.refresh();
      },

      getRows() {
        return omitHash(subscriber.rows);
      }
    };
  }

  async cleanup() {
    let keys = Object.keys(this.query_infos);

    let promises = keys.map(async key => {
      await this.query_infos[key].stop();
    });

    await Promise.all(promises);

    await this.table_observer.cleanup();
  }
}


//
// QueryInfo
//

class QueryInfo {
  constructor(query_observer, query, params, hash) {
    // Set basic fields

    this.query_observer = query_observer;
    this.db = query_observer.db;
    this.table_observer = query_observer.table_observer;
    this.options = query_observer.options;

    this.query = query;

    let hash_field;

    if(params === undefined) {
      hash_field = '1';
      params = [];
    }
    else if(Array.isArray(params)) {
      hash_field = params.length + 1;
    }
    else if(typeof params === 'object') {
      hash_field = '{___hashes}';
    }
    else {
      hash_field = '2';
      params = [ params ];
    }
    this.params = params;

    this.refresh_query = refreshQuery(query, hash_field, this.options.keyfield);

    this.hash = hash;

    this.notifier = undefined;
    this.triggered = false;

    this.subscribers = [];

    this.rows = undefined;
  }

  async init() {
    // Init notifier

    let tables = await tablesUsed(this.db, this.query, this.params);

    let any_trigger = (change) => {
      // Triggers if any of the subscriber's triggers trigger
      // Keep record of subscribers that triggered

      let subscribers = this.subscribers;

      subscribers.forEach(subscriber => {
        if(!subscriber.triggered) {
          if(subscriber.triggers(change)) {
            subscriber.triggered = true;
            this.triggered = true;
          }
        }
      });

      return this.triggered;
    };

    let options = {
      trigger_delay: this.options.trigger_delay,
      reduce_triggers: false, // need to know which subscribers trigger
      trigger_first: false, // callback is relatively costly
    };

    this.notifier = await this.table_observer.trigger(tables, any_trigger, () => this.refresh(), options);
  }

  async fetch() {
    // Create hashmap and collect hashes

    let hashmap = {};
    let hashes = [];

    if(this.rows) {
      this.rows.forEach(row => hashmap[row.___hash] = row);
      hashes = this.rows.map(row => row.___hash);
    }
    else {
      hashes = ['x']; // for some reason cannot be an empty array
    }

    // Prepare params

    let params;

    if(Array.isArray(this.params)) {
      params = this.params.concat([ hashes ]);
    }
    else {
      params = this.params;
      params.___hashes = hashes;
    }

    // Get new rows

    let rows = await this.db.any(this.refresh_query, params);

    // Reconstruct existing rows

    rows = rows.map(row => row.___hash in hashmap ? hashmap[row.___hash] : row );

    this.rows = rows;
  }

  async refresh() {
    if(this.triggered) {
      this.triggered = false;

      // Get new rows

      await this.fetch();

      // Iterate subscribers

      this.subscribers.forEach(subscriber => {
        if(subscriber.triggered) {
          subscriber.triggered = false;

          // Determine diff

          let old_rows = subscriber.rows;
          let new_rows = this.rows;

          let diff = rowsDiff(old_rows, new_rows, {
            equalFunc(old_row, new_row) { return old_row.___hash === new_row.___hash },
            keyfield: this.options.keyfield
          });

          subscriber.rows = new_rows;

          if(diff) {
            if(diff.added) diff.added = omitHash(diff.added);
            if(diff.changed) diff.changed = omitHash(diff.changed);

            subscriber.callback(diff);
          }
        }
      });
    }
  }

  async stop() {
    await this.notifier.stop();
    delete this.query_observer.query_infos[this.hash];
    this.query_observer = undefined;
  }

  addSubscriber(subscriber) {
    this.subscribers.push(subscriber);
  }

  async removeSubscriber(subscriber) {
    let index = this.subscribers.indexOf(subscriber);
    if(index === -1) throw new Error('Subscriber not found');
    subscribers.splice(index, 1);

    subscriber.query_info = undefined;

    if(!subscribers.length) {
      await this.stop();
    }
  }
}

//
// Subscriber
//

class Subscriber {
  constructor(query_info, triggers, callback) {
    this.query_info = query_info;
    this.triggers = triggers;
    this.callback = callback;

    this.rows = undefined;
    this.tiggered = false;

    this.options = query_info.options;
  }

  async init() {
    // Initial Rows

    if(!this.query_info.rows || !this.options.initial_cached) {
      await this.query_info.fetch();
    }
    else {
      // trigger update next time a change happens, just to be sure
      this.triggered = true;
      this.query_info.triggered = true;
    }

    this.rows = this.query_info.rows;

    // Add subscriber to query_info

    this.query_info.addSubscriber(this);
  }

  async refresh() {
    if(!this.triggered) {
      this.triggered = true;
      if(!this.query_info.triggered) {
        this.query_info.triggered = true;
        await this.query_info.refresh();
      }
    }
  }
}

//
// Helpers
//

function refreshQuery(query, hash_field, keyfield = '_id') {
  // query: original query string
  // hash_field: index into params of hashes which we already have (params.length + 1)
  // keyfield: name of the unique keyfield, defaults to _id

  return `
    WITH
      res AS (
        ${query}
      ),
      data AS (
        SELECT res.*, MD5(CAST(ROW_TO_JSON(res.*) AS TEXT)) AS ___hash
        FROM res
      ),
      data2 AS (
        SELECT data.*
        FROM data
        WHERE NOT (___hash = ANY ($${hash_field}))
      )
    SELECT data2.*, data.${keyfield} AS ${keyfield}, data.___hash AS ___hash
    FROM data
    LEFT JOIN data2 USING(${keyfield})
  `;
}

function omitHash(array) {
  return array.map(row => _.omit(row, '___hash'));
}

export default PgQueryObserver;
export { PgQueryObserver };
