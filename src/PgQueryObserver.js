import { murmur3 } from 'murmurhash-js';
import _ from 'lodash';

import PgTableObserver from '../../pg-table-observer/';
import rowsDiff from '../../rows-diff/';
import tablesUsed from '../../pg-analyze/';

class PgQueryObserver {
  constructor(db, channel, options = {}) {
    this.db = db;
    this.channel = channel;
    this.options = options;

    this.table_observer = new PgTableObserver(db, channel);
    this.query_infos = {}; // hash => { query, params, notifier, subscribers{ trigger, callback  } }

    // Handle default options

    // if(options.trigger_delay === undefined) options.trigger_delay = 200;
  }

  // Public Methods

  async notify(query, params, triggers, callback) {
    // Check parameters

    if(typeof query !== 'string')
      throw new TypeError('Query string missing');

    if(!Array.isArray(params))
      throw new TypeError('Params array missing');

    if(typeof triggers !== 'function')
      throw new TypeError('Triggers function missing');

    if(typeof callback !== 'function')
      throw new TypeError('Callback function missing');

    // Find or create query_info

    let query_info = await this._getQueryInfo(query, params);

    // Get initial resultset
    // NOTE maybe has to be sooner in case it fails?

    if(!query_info.rows) {
      await query_info._fetch();
      // TODO issue refresh
    }

    let rows = query_info.rows;

    // Add subscriber

    let subscriber_key = `_${query_info.nextid}`;
    query_info.nextid++;

    query_info.subscribers[subscriber_key] = {
      rows,
      triggers,
      callback,

      triggered: false,
    };

    query_info.subscriber_count++;

    // Return result handle

    return {
      rows,

      async stop() {
        // Remove subscriber

        delete query_info.subscribers[subscriber_key];
        query_info.subscriber_count--;

        // No subscribers left? Cleanup query_info

        if(query_info.subscriber_count === 0) {
          await query_info.stop();
        }
      },

      async refresh() {
        await query_info.refresh();
      }
    };
  }

  async cleanup() {
    this.table_observer.cleanup();
  }

  async _getQueryInfo(query, params) {
    // Create query hash

    let hash = murmur3(JSON.stringify([ query, params ]));

    // Return if we already have query_info

    if(this.query_infos[hash]) return this.query_infos[hash];

    // Trigger function for table_observer

    let query_info; // Will be set later

    // Create notifier for tables used in query

    let db = this.db;

    let tables = await tablesUsed(db, query, params);

    function any_trigger(change) {
      // Triggers if any of the subscriber's triggers trigger
      // Keep record of subscribers that triggered

      let subscribers = query_info.subscribers;
      let keys = Object.keys(subscribers);

      keys.forEach(key => {
        let subscriber = subscribers[key];

        if(!subscriber.triggered) {
          if(subscriber.triggers(change)) {
            subscriber.triggered = true;
            query_info.triggered = true;
          }
        }
      });

      return query_info.triggered;
    }

    function refresh() {
      console.log("refresh");
      query_info.refresh();
    }

    let options = {
      trigger_delay: this.options.trigger_delay,
      reduce_triggers: false,
    };

    let notifier = await this.table_observer.trigger(tables, any_trigger, refresh, options);

    // Create refresh_query

    let refresh_query = refreshQuery(query, params.length + 1);

    // Build queryinfo

    let _this = this;

    query_info = {
      rows: undefined,
      old_hashes: undefined,

      nextid: 1,
      subscriber_count: 0,
      subscribers: {},

      async _fetch() {
        // Create hashmap and collect hashes

        let hashmap = {};
        let hashes = ['x'];

        if(this.rows) {
          this.rows.forEach(row => hashmap[row._hash] = row);
          hashes = this.rows.map(row => row._hash);
        }

        // Get new rows

        let rows = await _this.db.any(refresh_query, params.concat([ hashes ]));

        // Reconstruct existing rows

        rows = rows.map(row => row._hash in hashmap ? hashmap[row._hash] : row );

        this.rows = rows;
      },

      async refresh() {
        if(this.triggered) {
          await this._fetch();
          this.triggered = false;

          let keys = Object.keys(this.subscribers);

          keys.forEach(key => {
            let subscriber = this.subscribers[key];

            if(subscriber.triggered) {
              subscriber.triggered = false;

              let old_rows = subscriber.rows;
              let new_rows = this.rows;

              let diff = rowsDiff(old_rows, new_rows, {
                equalFunc(old_row, new_row) { return old_row._hash === new_row._hash }
              });

              subscriber.rows = new_rows;

              if(diff) {
                subscriber.callback(diff);
              }
            }
          });
        }
      },

      async stop() {
        await notifier.stop();
        delete _this.query_infos[hash];
      },
    };

    this.query_infos[hash] = query_info;

    return query_info;
  }
}







function refreshQuery(query, hashParam) {
  return `
    /*
     * Template for refreshing a result set, only returning unknown rows
     * Accepts 2 arguments:
     * query: original query string
     * hashParam: count of params in original query + 1
     */
    WITH
      res AS (${query}),
      data AS (
        SELECT res.*,
          MD5(CAST(ROW_TO_JSON(res.*) AS TEXT)) AS _hash
        FROM res
      ),
      data2 AS (
        SELECT data.*
        FROM data
        WHERE NOT (_hash = ANY ($${hashParam}))
      )
    SELECT data2.*, data._id AS _id, data._hash AS _hash
    FROM data
    LEFT JOIN data2 USING(_id)
  `;
}

export default PgQueryObserver;
export { PgQueryObserver };
