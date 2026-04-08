# Purchase Order Approval Application

A web-based application for managing SAP Purchase Orders with approval workflows, vendor performance tracking, and real-time SAP ECC 6.0 integration via Flow MCP.

## Features

### 1. Purchase Order Management
- **View Pending POs**: Browse all purchase orders awaiting approval with filtering by date range
- **PO Details**: View comprehensive PO information including:
  - Header details (PO number, vendor, document date, total value)
  - Line items with material, quantity, price, and delivery dates
  - Release strategy and approval status
- **Create New POs**: Create purchase orders with:
  - Vendor selection
  - Material and quantity specification
  - Automatic pricing from SAP conditions
  - Delivery date scheduling
  - Real-time validation

### 2. Approval Workflow
- **Approve POs**: Release purchase orders using SAP release codes (e.g., Z1)
- **Reject POs**: Reset release status with proper SAP transaction handling
- **Release Strategy**: Automatic detection and display of release codes
- **Transaction Commit**: Ensures data consistency with SAP BAPI_TRANSACTION_COMMIT

### 3. Vendor Performance Dashboard
- **Vendor Metrics**: Track key performance indicators:
  - Total POs per vendor
  - Total spend amount
  - Average PO value
  - On-time delivery rate
- **Time-based Analysis**: Performance data for the last 12 months
- **Vendor Selection**: Filter by vendors who have active purchase orders

### 4. Real-time SAP Integration
- **Live SAP Connection**: Direct integration with SAP ECC 6.0 via Flow MCP
- **Fast Data Retrieval**: Uses RFC_READ_TABLE for optimized performance
- **BAPI Operations**: 
  - BAPI_PO_CREATE1 for PO creation
  - BAPI_PO_RELEASE for approvals
  - BAPI_PO_RESET_RELEASE for rejections
  - RFC_READ_TABLE for data queries
- **Error Handling**: Comprehensive SAP error message display

## Architecture

### Frontend (`frontend/`)
- **Technology**: Vanilla JavaScript, HTML5, CSS3
- **UI Components**:
  - Navigation tabs (PO List, Create PO, Vendor Dashboard)
  - Dynamic forms with validation
  - Real-time status updates
  - Error and success notifications

### Backend (`backend/`)
- **Technology**: Node.js, Express
- **Port**: 3000
- **Routes**:
  - `/api/pos` - Get pending POs
  - `/api/pos/:id` - Get PO details
  - `/api/pos/create` - Create new PO
  - `/api/pos/:id/approve` - Approve PO
  - `/api/pos/:id/reject` - Reject PO
  - `/api/vendors` - Get vendor list
  - `/api/vendors/:id/performance` - Get vendor performance metrics

### MCP Server (`mcp-server/`)
- **Technology**: Node.js, @modelcontextprotocol/sdk
- **Port**: 3001
- **Purpose**: Provides MCP tools for SAP operations
- **SAP Client**: Handles all BAPI calls and RFC operations via Flow MCP

## Configuration

### Environment Variables (`.env`)
```
USE_MOCK=false                    # Set to true for mock data, false for live SAP
FLOW_API_KEY=your_api_key_here   # Flow MCP API key
FLOW_MCP_URL=https://flow.pillir.ai/mcp/sse
SAP_COMPANY_CODE=1000
SAP_PLANT=1000
SAP_PURCHASE_ORG=1000
SAP_PURCHASE_GROUP=001
```

### SAP System Details
- **System Type**: SAP ECC 6.0
- **Fiscal Year Variant**: K4
- **Date Formats**:
  - Document dates: DD.MM.YYYY (e.g., "25.03.2026")
  - Schedule line dates: YYYYMMDD (e.g., "20260325")
  - Filter dates: YYYYMMDD for RFC_READ_TABLE queries

## Installation

1. Install dependencies:
```bash
npm install
cd mcp-server && npm install && cd ..
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your Flow API key and SAP settings
```

3. Start the servers:
```bash
# Terminal 1: Start backend
npm start

# Terminal 2: Start MCP server
cd mcp-server && npm start
```

4. Open browser:
```
http://localhost:3000
```

## Usage

### Creating a Purchase Order
1. Click "Create Purchase Order" tab
2. Enter vendor ID (e.g., 1000)
3. Enter material number (e.g., 100-100)
4. Specify quantity and delivery date
5. Click "Create PO"
6. System will display PO number and any warnings

### Approving/Rejecting POs
1. View pending POs in the list
2. Click "View Details" on a PO
3. Review PO information
4. Enter release code (e.g., Z1)
5. Click "Approve" or "Reject"

### Viewing Vendor Performance
1. Click "Vendor Performance" tab
2. Select a vendor from the dropdown
3. View metrics and performance indicators

## Technical Details

### Date Format Handling
The application uses different date formats for different SAP operations:
- **PO Creation (BAPI_PO_CREATE1)**: DD.MM.YYYY for document dates
- **Schedule Lines**: YYYYMMDD for delivery dates
- **Table Queries (RFC_READ_TABLE)**: YYYYMMDD for filtering

### Performance Optimizations
- Uses RFC_READ_TABLE instead of slow BAPIs for data retrieval
- Implements 90-second timeout for SAP operations
- Caches vendor lists from PO data
- Filters data by date range (last 12 months)

### Error Handling
- Displays SAP error messages directly to users
- Separates warnings from errors
- Shows success messages even when warnings exist
- Logs detailed error information for debugging

## Future Enhancement Ideas

1. **Advanced Filtering**:
   - Filter POs by vendor, material, or value range
   - Search functionality
   - Sort by different columns

2. **Reporting**:
   - Export PO lists to Excel/CSV
   - Generate approval reports
   - Vendor performance trends over time

3. **User Management**:
   - Role-based access control
   - Approval limits by user
   - Audit trail for all actions

4. **Notifications**:
   - Email alerts for pending approvals
   - Deadline reminders
   - Approval confirmations

5. **Bulk Operations**:
   - Approve multiple POs at once
   - Batch PO creation
   - Mass vendor updates

6. **Analytics**:
   - Spending analysis by category
   - Approval cycle time metrics
   - Vendor comparison charts

7. **Mobile Support**:
   - Responsive design for tablets/phones
   - Mobile app for approvals on-the-go

8. **Integration Enhancements**:
   - Goods receipt tracking
   - Invoice matching
   - Contract management

## Troubleshooting

### PO List is Empty
- Check date range filter (default: last 1 year)
- Verify SAP connection is active (USE_MOCK=false)
- Ensure Flow API key is valid

### Timeout Errors
- Check network connectivity to Flow MCP
- Verify SAP system is responsive
- Review timeout settings (currently 90s)

### PO Creation Fails
- Verify vendor exists in SAP
- Check material number is valid
- Ensure delivery date is within fiscal calendar
- Review SAP error messages in response

### Approval/Rejection Not Working
- Verify PO has a release strategy configured
- Check release code is correct (e.g., Z1)
- Ensure PO is in correct status for release

## Support

For issues or questions:
1. Check QUICK-REFERENCE.md for common operations
2. Review SAP error messages in the UI
3. Check browser console for detailed logs
4. Verify .env configuration

## License

Internal use only - SAP integration for purchase order management.
