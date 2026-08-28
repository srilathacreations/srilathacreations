export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -----------------------------
    // API TEST
    // -----------------------------
    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const result = await env.DB
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all();

        return Response.json({
          success: true,
          message: "Srilatha Creations backend is working",
          database: "Connected",
          tables: result.results
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // -----------------------------
    // PRODUCTS
    // -----------------------------
    if (url.pathname === "/api/products" && request.method === "GET") {
      try {
        const products = await env.DB
          .prepare(
            "SELECT * FROM products WHERE is_active = 1 ORDER BY id DESC"
          )
          .all();

        return Response.json(products.results);
      } catch (error) {
        return Response.json(
          {
            success: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // -----------------------------
    // CREATE ORDER - COD
    // -----------------------------
    if (url.pathname === "/api/orders" && request.method === "POST") {
      try {
        const body = await request.json();

        const customer = body.customer || {};
        const items = Array.isArray(body.items) ? body.items : [];

        const name = String(customer.name || "").trim();
        const phone = String(customer.phone || "").trim();
        const email = String(customer.email || "").trim();
        const address = String(customer.address || "").trim();
        const city = String(customer.city || "").trim();
        const state = String(customer.state || "").trim();
        const pincode = String(customer.pincode || "").trim();

        // Basic validation
        if (!name) {
          return Response.json(
            { success: false, error: "Customer name is required" },
            { status: 400 }
          );
        }

        if (!phone || phone.length < 10) {
          return Response.json(
            { success: false, error: "Valid phone number is required" },
            { status: 400 }
          );
        }

        if (!address) {
          return Response.json(
            { success: false, error: "Delivery address is required" },
            { status: 400 }
          );
        }

        if (!items.length) {
          return Response.json(
            { success: false, error: "Cart is empty" },
            { status: 400 }
          );
        }

        // -------------------------------------------------
        // Validate products and calculate totals on server
        // Never trust price sent by browser
        // -------------------------------------------------
        const validatedItems = [];
        let subtotal = 0;

        for (const cartItem of items) {
          const productId = Number(cartItem.id || cartItem.product_id);
          const quantity = Number(cartItem.qty || cartItem.quantity || 0);

          if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
            return Response.json(
              { success: false, error: "Invalid cart item" },
              { status: 400 }
            );
          }

          const product = await env.DB
            .prepare(
              `SELECT
                id,
                name,
                price,
                sale_price,
                stock,
                is_active
               FROM products
               WHERE id = ?`
            )
            .bind(productId)
            .first();

          if (!product || Number(product.is_active) !== 1) {
            return Response.json(
              {
                success: false,
                error: "One of the selected products is unavailable"
              },
              { status: 400 }
            );
          }

          if (Number(product.stock) < quantity) {
            return Response.json(
              {
                success: false,
                error: `${product.name} has only ${product.stock} item(s) available`
              },
              { status: 400 }
            );
          }

          const regularPrice = Number(product.price || 0);
          const salePrice =
            product.sale_price !== null
              ? Number(product.sale_price)
              : 0;

          const finalPrice =
            salePrice > 0 ? salePrice : regularPrice;

          const lineTotal = finalPrice * quantity;

          subtotal += lineTotal;

          validatedItems.push({
            product_id: Number(product.id),
            product_name: product.name,
            quantity,
            price: finalPrice,
            total: lineTotal
          });
        }

        // -------------------------------------------------
        // Delivery charge
        // Currently ₹0
        // We can add shipping rules later
        // -------------------------------------------------
        const deliveryCharge = 0;
        const totalAmount = subtotal + deliveryCharge;

        // -------------------------------------------------
        // Find existing customer by phone
        // -------------------------------------------------
        let customerRow = await env.DB
          .prepare(
            "SELECT id FROM customers WHERE phone = ? ORDER BY id DESC LIMIT 1"
          )
          .bind(phone)
          .first();

        let customerId;

        if (customerRow) {
          customerId = customerRow.id;

          await env.DB
            .prepare(
              `UPDATE customers
               SET
                 name = ?,
                 email = ?,
                 address = ?,
                 city = ?,
                 state = ?,
                 pincode = ?
               WHERE id = ?`
            )
            .bind(
              name,
              email || null,
              address,
              city || null,
              state || null,
              pincode || null,
              customerId
            )
            .run();
        } else {
          const newCustomer = await env.DB
            .prepare(
              `INSERT INTO customers
               (name, phone, email, address, city, state, pincode)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING id`
            )
            .bind(
              name,
              phone,
              email || null,
              address,
              city || null,
              state || null,
              pincode || null
            )
            .first();

          customerId = newCustomer.id;
        }

        // -------------------------------------------------
        // Generate order number
        // Example: SC-20260828-123456
        // -------------------------------------------------
        const now = new Date();

        const datePart =
          now.getUTCFullYear().toString() +
          String(now.getUTCMonth() + 1).padStart(2, "0") +
          String(now.getUTCDate()).padStart(2, "0");

        const randomPart = Math.floor(
          100000 + Math.random() * 900000
        );

        const orderNumber = `SC-${datePart}-${randomPart}`;

        // -------------------------------------------------
        // Create main order
        // -------------------------------------------------
        const order = await env.DB
          .prepare(
            `INSERT INTO orders (
              order_number,
              customer_id,
              customer_name,
              phone,
              email,
              address,
              city,
              state,
              pincode,
              subtotal,
              delivery_charge,
              total_amount,
              payment_method,
              payment_status,
              payment_id,
              order_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id`
          )
          .bind(
            orderNumber,
            customerId,
            name,
            phone,
            email || null,
            address,
            city || null,
            state || null,
            pincode || null,
            subtotal,
            deliveryCharge,
            totalAmount,
            "COD",
            "pending",
            null,
            "pending"
          )
          .first();

        const orderId = order.id;

        // -------------------------------------------------
        // Insert order items + reduce stock
        // -------------------------------------------------
        const statements = [];

        for (const item of validatedItems) {
          statements.push(
            env.DB
              .prepare(
                `INSERT INTO order_items
                 (
                   order_id,
                   product_id,
                   product_name,
                   quantity,
                   price,
                   total
                 )
                 VALUES (?, ?, ?, ?, ?, ?)`
              )
              .bind(
                orderId,
                item.product_id,
                item.product_name,
                item.quantity,
                item.price,
                item.total
              )
          );

          statements.push(
            env.DB
              .prepare(
                `UPDATE products
                 SET stock = stock - ?
                 WHERE id = ?
                 AND stock >= ?`
              )
              .bind(
                item.quantity,
                item.product_id,
                item.quantity
              )
          );
        }

        if (statements.length) {
          await env.DB.batch(statements);
        }

        // -------------------------------------------------
        // Success
        // -------------------------------------------------
        return Response.json(
          {
            success: true,
            message: "Order placed successfully",
            order: {
              id: orderId,
              order_number: orderNumber,
              customer_name: name,
              phone,
              subtotal,
              delivery_charge: deliveryCharge,
              total_amount: totalAmount,
              payment_method: "COD",
              payment_status: "pending",
              order_status: "pending"
            }
          },
          { status: 201 }
        );
      } catch (error) {
        console.error("Order API error:", error);

        return Response.json(
          {
            success: false,
            error: error.message || "Unable to place order"
          },
          { status: 500 }
        );
      }
    }

    // -----------------------------
    // GET ORDER BY ORDER NUMBER
    // -----------------------------
    if (
      url.pathname.startsWith("/api/orders/") &&
      request.method === "GET"
    ) {
      try {
        const orderNumber = decodeURIComponent(
          url.pathname.replace("/api/orders/", "")
        );

        if (!orderNumber) {
          return Response.json(
            { success: false, error: "Order number required" },
            { status: 400 }
          );
        }

        const order = await env.DB
          .prepare(
            "SELECT * FROM orders WHERE order_number = ?"
          )
          .bind(orderNumber)
          .first();

        if (!order) {
          return Response.json(
            { success: false, error: "Order not found" },
            { status: 404 }
          );
        }

        const items = await env.DB
          .prepare(
            "SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC"
          )
          .bind(order.id)
          .all();

        return Response.json({
          success: true,
          order,
          items: items.results
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // -----------------------------
    // Existing website / assets
    // -----------------------------
    return env.ASSETS.fetch(request);
  }
};
