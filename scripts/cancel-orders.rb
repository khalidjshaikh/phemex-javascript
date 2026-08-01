#!/usr/bin/env ruby

`phemex-cli get_open_orders --symbol XTIUSDT | jq ".rows[].orderID"`.split(/\"|\n/).reject{|i|i==""}.map{|i| `phemex-cli cancel_order --symbol XTIUSDT --orderID #{i} --posSide Long`}

