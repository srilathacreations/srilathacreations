export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // HELPERS
    // =====================================================

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      });

    const getAdminToken = () => {
      const auth = request.headers.get("Authorization") || "";
      if (auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
      }

      return request.headers.get("X-Admin-Token") || "";
    };

    const isAdmin = () => {
      if (!env.ADMIN_TOKEN) return false;
      return getAdminToken() === env.ADMIN_TOKEN;
    };

    // =====================================================
    // API TEST
    // =====================================================

    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const result = await env.DB
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all();

        return json({
          success: true,
          message: "Srilatha Creations backend is working",
          database: "Connected",
          tables: result.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // PUBLIC PRODUCTS API
    // =====================================================

    if (url.pathname === "/api/products" && request.method === "GET") {
      try {
        const products = await env.DB
          .prepare(
            "SELECT * FROM products WHERE is_active = 1 ORDER BY id DESC"
          )
          .all();

        return json(products.results);
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // CREATE COD ORDER
    // =====================================================

    if (url.pathname === "/api/orders" && request.method === "POST") {
      try {
        const body = await request.json();

        const customerName = String(body.customer_name || "").trim();
        const phone = String(body.phone || "").replace(/\D/g, "");
        const email = String(body.email || "").trim();
        const address = String(body.address || "").trim();
        const city = String(body.city || "").trim();
        const state = String(body.state || "").trim();
        const pincode = String(body.pincode || "").replace(/\D/g, "");
        const items = Array.isArray(body.items) ? body.items : [];

        if (!customerName) {
          return json(
            { success: false, error: "Customer name is required" },
            400
          );
        }

        if (phone.length !== 10) {
          return json(
            { success: false, error: "Enter a valid 10 digit phone number" },
            400
          );
        }

        if (!address) {
          return json(
            { success: false, error: "Delivery address is required" },
            400
          );
        }

        if (!city) {
          return json(
            { success: false, error: "City is required" },
            400
          );
        }

        if (!state) {
          return json(
            { success: false, error: "State is required" },
            400
          );
        }

        if (pincode.length !== 6) {
          return json(
            { success: false, error: "Enter a valid 6 digit PIN code" },
            400
          );
        }

        if (!items.length) {
          return json(
            { success: false, error: "Cart is empty" },
            400
          );
        }

        let subtotal = 0;
        const verifiedItems = [];

        for (const item of items) {
          const productId = Number(item.id || item.product_id);
          const quantity = Math.max(1, Number(item.qty || item.quantity || 1));

          if (!Number.isInteger(productId) || productId <= 0) {
            return json(
              { success: false, error: "Invalid product" },
              400
            );
          }

          const product = await env.DB
            .prepare(
              "SELECT * FROM products WHERE id = ? AND is_active = 1"
            )
            .bind(productId)
            .first();

          if (!product) {
            return json(
              {
                success: false,
                error: `Product ${productId} is not available`
              },
              400
            );
          }

          if (Number(product.stock) < quantity) {
            return json(
              {
                success: false,
                error: `${product.name} has only ${product.stock} available`
              },
              400
            );
          }

          const unitPrice =
            product.sale_price !== null &&
            product.sale_price !== undefined
              ? Number(product.sale_price)
              : Number(product.price);

          const itemTotal = unitPrice * quantity;

          subtotal += itemTotal;

          verifiedItems.push({
            product_id: Number(product.id),
            product_name: product.name,
            quantity,
            price: unitPrice,
            total: itemTotal
          });
        }

        const deliveryCharge = 0;
        const totalAmount = subtotal + deliveryCharge;

        const now = new Date();

        const datePart =
          now.getUTCFullYear().toString() +
          String(now.getUTCMonth() + 1).padStart(2, "0") +
          String(now.getUTCDate()).padStart(2, "0");

        const randomPart = Math.floor(100000 + Math.random() * 900000);

        const orderNumber = `SC-${datePart}-${randomPart}`;

        let customer = await env.DB
          .prepare("SELECT * FROM customers WHERE phone = ? LIMIT 1")
          .bind(phone)
          .first();

        let customerId;

        if (customer) {
          customerId = customer.id;

          await env.DB
            .prepare(
              `UPDATE customers
               SET name = ?,
                   email = ?,
                   address = ?,
                   city = ?,
                   state = ?,
                   pincode = ?
               WHERE id = ?`
            )
            .bind(
              customerName,
              email || null,
              address,
              city,
              state,
              pincode,
              customerId
            )
            .run();
        } else {
          const customerInsert = await env.DB
            .prepare(
              `INSERT INTO customers
               (name, phone, email, address, city, state, pincode)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              customerName,
              phone,
              email || null,
              address,
              city,
              state,
              pincode
            )
            .run();

          customerId = customerInsert.meta.last_row_id;
        }

        const orderInsert = await env.DB
          .prepare(
            `INSERT INTO orders
            (
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
              order_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            orderNumber,
            customerId,
            customerName,
            phone,
            email || null,
            address,
            city,
            state,
            pincode,
            subtotal,
            deliveryCharge,
            totalAmount,
            "COD",
            "pending",
            "pending"
          )
          .run();

        const orderId = orderInsert.meta.last_row_id;

        for (const item of verifiedItems) {
          await env.DB
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
            .run();

          await env.DB
            .prepare(
              `UPDATE products
               SET stock = stock - ?
               WHERE id = ?`
            )
            .bind(item.quantity, item.product_id)
            .run();
        }

        return json({
          success: true,
          message: "Order placed successfully",
          order_id: orderId,
          order_number: orderNumber,
          total: totalAmount
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN AUTH CHECK
    // =====================================================

    if (url.pathname === "/api/admin/check" && request.method === "GET") {
      if (!isAdmin()) {
        return json(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      return json({
        success: true,
        message: "Admin authenticated"
      });
    }

    // =====================================================
    // ADMIN - GET ALL ORDERS
    // =====================================================

    if (url.pathname === "/api/admin/orders" && request.method === "GET") {
      if (!isAdmin()) {
        return json(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      try {
        const result = await env.DB
          .prepare(
            `SELECT
              id,
              order_number,
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
              order_status,
              created_at
             FROM orders
             ORDER BY id DESC
             LIMIT 500`
          )
          .all();

        return json({
          success: true,
          orders: result.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN - GET ONE ORDER
    // =====================================================

    const orderMatch = url.pathname.match(
      /^\/api\/admin\/orders\/(\d+)$/
    );

    if (orderMatch && request.method === "GET") {
      if (!isAdmin()) {
        return json(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      try {
        const orderId = Number(orderMatch[1]);

        const order = await env.DB
          .prepare("SELECT * FROM orders WHERE id = ?")
          .bind(orderId)
          .first();

        if (!order) {
          return json(
            {
              success: false,
              error: "Order not found"
            },
            404
          );
        }

        const items = await env.DB
          .prepare(
            "SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC"
          )
          .bind(orderId)
          .all();

        return json({
          success: true,
          order,
          items: items.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN - UPDATE ORDER STATUS
    // =====================================================

    const statusMatch = url.pathname.match(
      /^\/api\/admin\/orders\/(\d+)\/status$/
    );

    if (statusMatch && request.method === "PUT") {
      if (!isAdmin()) {
        return json(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      try {
        const orderId = Number(statusMatch[1]);
        const body = await request.json();

        const newStatus = String(body.order_status || "")
          .trim()
          .toLowerCase();

        const allowedStatuses = [
          "pending",
          "confirmed",
          "processing",
          "shipped",
          "delivered",
          "cancelled"
        ];

        if (!allowedStatuses.includes(newStatus)) {
          return json(
            {
              success: false,
              error: "Invalid order status"
            },
            400
          );
        }

        const existingOrder = await env.DB
          .prepare("SELECT * FROM orders WHERE id = ?")
          .bind(orderId)
          .first();

        if (!existingOrder) {
          return json(
            {
              success: false,
              error: "Order not found"
            },
            404
          );
        }

        const oldStatus = String(
          existingOrder.order_status || "pending"
        ).toLowerCase();

        if (oldStatus === "cancelled" && newStatus !== "cancelled") {
          return json(
            {
              success: false,
              error: "Cancelled order cannot be reopened"
            },
            400
          );
        }

        // Restore stock only when cancelling for the first time
        if (newStatus === "cancelled" && oldStatus !== "cancelled") {
          const items = await env.DB
            .prepare(
              "SELECT * FROM order_items WHERE order_id = ?"
            )
            .bind(orderId)
            .all();

          for (const item of items.results) {
            if (item.product_id) {
              await env.DB
                .prepare(
                  `UPDATE products
                   SET stock = stock + ?
                   WHERE id = ?`
                )
                .bind(
                  Number(item.quantity),
                  Number(item.product_id)
                )
                .run();
            }
          }
        }

        await env.DB
          .prepare(
            `UPDATE orders
             SET order_status = ?
             WHERE id = ?`
          )
          .bind(newStatus, orderId)
          .run();

        return json({
          success: true,
          message: "Order status updated",
          order_id: orderId,
          order_status: newStatus
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // STATIC WEBSITE
    // =====================================================

    return env.ASSETS.fetch(request);
  }
};
